import {
  FAILS_BEFORE_ALERT, sum, availability, latency,
  budgetRemaining, budgetMinutes, percentile, alertFor, burnRate, burndown, failingSince,
  hourlyBurn, fleet,
} from './slo.js';

// What gets probed. Hardcoded on purpose: no request can make this Worker
// fetch a URL of its choosing, so it cannot be used as an open proxy.
const TARGETS = [
  { id: 'portfolio', name: 'Portfolio', url: 'https://theoith.ink/',
    cron: '*/5 * * * *', timeout: 10_000, threshold: 1000, slo: 0.999, latencySlo: 0.99 },
  { id: 'writeups', name: 'CTF writeups', url: 'https://writeups.theoith.ink/',
    cron: '*/5 * * * *', timeout: 10_000, threshold: 1000, slo: 0.999, latencySlo: 0.99 },
  // Render's free tier sleeps after 15 idle minutes. Probing hourly lets it
  // sleep, so this measures the cold start a real visitor gets.
  // source: the probe runs outside Cloudflare and POSTs its result to /ingest,
  // because the bot check in front of onrender.com blocks requests from Workers.
  // The cron is when this Worker starts that probe on GitHub (see startHulogProbe).
  { id: 'hulog', name: 'Hulog', url: 'https://hulog.onrender.com/', source: 'github',
    cron: '5 * * * *', timeout: 90_000, threshold: 60_000, slo: 0.99, latencySlo: 0.95 },
];
// The only targets /ingest accepts. Anything else is a 404.
const EXTERNAL = new Map(TARGETS.filter((t) => t.source).map((t) => [t.id, t]));
// Starts .github/workflows/probe-hulog.yml. Hardcoded like TARGETS, so no request
// can point the Worker, or its GitHub token, anywhere else.
const HULOG_DISPATCH = 'https://api.github.com/repos/theoithinkk/uptime-monitor/actions/workflows/probe-hulog.yml/dispatches';
// Not probed and not shown as a panel; the page footer names each one and its
// `why`. Empty for now. A paused target keeps its settings so it can move back.
const PAUSED = [];
// Must match the crons in wrangler.toml.
const EVERY = { '*/5 * * * *': 'every 5 minutes', '5 * * * *': 'every hour' };
// Probes per day for each cron. The error budget is counted against a full
// window of probes, so a failure on day one costs what it would on day 30.
const PER_DAY = { '*/5 * * * *': 288, '5 * * * *': 24 };
// A target is Stale when its newest probe is older than this many intervals.
// External probes can stop without an error here: a GitHub run can fail to start,
// and GitHub turns off workflows in a repo with no activity for 60 days.
const STALE_AFTER = 3;
// A token holder can add at most one probe per target per 30 minutes,
// so a leaked token cannot flood the history.
const INGEST_QUIET_MS = 30 * 60 * 1000;
const INGEST_MAX_BYTES = 1024;
const INGEST_FIELDS = ['target', 'ok', 'status', 'ms', 'err'];

const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Fewest probes a burn rate is shown for. Below this one failure moves the rate
// in steps too big to mean anything, so Hulog's hourly probe gets no 1 h rate.
const BURN_MIN_PROBES = 10;
const USER_AGENT = 'theo-uptime/1.0';
const HEADERS = {
  'content-security-policy':
    // img-src data: is only for the inline status-dot favicon.
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'public, max-age=60',
};

const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

// ---------- probing ----------

async function probe(t) {
  const ts = Date.now();
  try {
    const res = await fetch(t.url, {
      signal: AbortSignal.timeout(t.timeout),
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT },
    });
    // Workers freeze the clock while code runs and move it on I/O,
    // so this is network time up to the response headers.
    const ms = Date.now() - ts;
    await res.body?.cancel().catch(() => {}); // the body is not part of the SLI
    return { ts, ok: res.ok, status: res.status, ms, err: null };
  } catch (e) {
    const err = e.name === 'TimeoutError'
      ? `timeout after ${t.timeout / 1000} s`
      : String(e.message || e).slice(0, 200);
    return { ts, ok: false, status: null, ms: Date.now() - ts, err };
  }
}

// Returns false when the row was refused because the target already has a
// probe newer than r.ts - quietMs. With quietMs 0 that needs a probe from the
// future, so the cron path never hits it.
async function record(env, t, r, quietMs = 0) {
  const ok = r.ok ? 1 : 0;
  const fast = r.ok && r.ms <= t.threshold ? 1 : 0;
  // A batch runs as one transaction, so the raw row and the rollup never disagree,
  // and two racing requests cannot both pass the quiet-time check and both insert.
  // Both statements carry the same check, and the rollup runs first, so both see
  // the table as it was before this probe: they go in together or not at all.
  const quiet = 'WHERE NOT EXISTS (SELECT 1 FROM probes WHERE target = ?1 AND ts > ?2 - ?3)';
  const [, raw] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO daily (target, day, total, good, fast)
      SELECT ?1, ?4, 1, ?5, ?6 ${quiet}
      ON CONFLICT(target, day) DO UPDATE SET
        total = total + 1, good = good + excluded.good, fast = fast + excluded.fast`)
      .bind(t.id, r.ts, quietMs, dayOf(r.ts), ok, fast),
    env.DB.prepare(`INSERT INTO probes (target, ts, ok, status, ms, err)
      SELECT ?1, ?2, ?4, ?5, ?6, ?7 ${quiet}`)
      .bind(t.id, r.ts, quietMs, ok, r.status, r.ms, r.err),
  ]);
  return raw.meta.changes === 1;
}

async function alertIfChanged(env, t, r) {
  try {
    const { results } = await env.DB
      .prepare('SELECT ok FROM probes WHERE target = ?1 ORDER BY ts DESC LIMIT ?2')
      .bind(t.id, FAILS_BEFORE_ALERT + 1)
      .all();
    const kind = alertFor(results.map((row) => row.ok));
    if (!kind) return;
    const detail = r.ok ? `HTTP ${r.status} in ${r.ms} ms` : (r.err ?? `HTTP ${r.status}`);
    const text = kind === 'DOWN'
      ? `DOWN: ${t.name} failed ${FAILS_BEFORE_ALERT} probes in a row (${detail}). ${t.url}`
      : `RECOVERED: ${t.name} is answering again (${detail}). ${t.url}`;
    await sendTelegram(env, text);
  } catch (e) {
    // The probe is already recorded. A lost alert must never cost a data point.
    console.error(`alert for ${t.id} failed: ${e.message}`);
  }
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log(`Telegram secrets not set, alert skipped: ${text}`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text(); // Telegram's error text never contains the token
  if (!res.ok) throw new Error(`Telegram answered ${res.status}: ${body.slice(0, 200)}`);
  console.log(`alert sent: ${text}`);
}

// GitHub's own schedule skipped most hourly runs, and Cloudflare's cron does not,
// so the Worker starts the run. The probe itself still runs on GitHub. A start that
// fails is only logged: the missed hour shows as Stale, and nothing else waits on it.
async function startHulogProbe(env) {
  if (!env.GH_DISPATCH_TOKEN) {
    console.warn('GH_DISPATCH_TOKEN not set, Hulog probe not started');
    return;
  }
  try {
    const res = await fetch(HULOG_DISPATCH, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT, // GitHub refuses requests without one
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text(); // GitHub's error text never contains the token
    if (res.status === 204) console.log('Hulog probe started on GitHub Actions');
    // GitHub pretty-prints its JSON; one line reads better in wrangler tail.
    else console.error(`GitHub answered ${res.status} to the Hulog dispatch: ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
  } catch (e) {
    console.error(`Hulog dispatch failed: ${String(e.message || e).slice(0, 200)}`);
  }
}

// ---------- status page ----------

// Reads about 700 rows per view: per target, 30 daily rows, every raw row from
// the last 24 h (about 288) and the newest probe. The 24 h query read the failed
// probes before as well (ok is not part of the key), so returning them for the
// burn rate and the latency line costs no extra rows.
async function loadStats(env, now) {
  const since = dayOf(now - (WINDOW_DAYS - 1) * DAY_MS);
  const res = await env.DB.batch(TARGETS.flatMap((t) => [
    env.DB.prepare('SELECT ts, ok, status, ms, err FROM probes WHERE target = ?1 ORDER BY ts DESC LIMIT 1')
      .bind(t.id),
    env.DB.prepare('SELECT day, total, good, fast FROM daily WHERE target = ?1 AND day >= ?2')
      .bind(t.id, since),
    env.DB.prepare('SELECT ts, ok, ms FROM probes WHERE target = ?1 AND ts >= ?2 ORDER BY ts')
      .bind(t.id, now - DAY_MS),
  ]));
  return TARGETS.map((t, i) => {
    const [last, days, recent] = res.slice(i * 3, i * 3 + 3).map((r) => r.results);
    return { t, last: last[0] ?? null, days, recent };
  });
}

// Every value that reaches the HTML goes through this, database values included.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (x, digits = 2) => `${(x * 100).toFixed(digits)}%`.replace('-', '−'); // a real minus sign
const target = (x) => `${+(x * 100).toFixed(2)}%`; // 0.999 -> 99.9%
// Milliseconds under a second, seconds above, so 1840 ms reads 1.8 s next to a 1 s goal.
const dur = (ms) => (ms < 1000 ? `${ms} ms` : `${+(ms / 1000).toFixed(1)} s`);
const stamp = (ts) => `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const rate = (x) => `${x.toFixed(x < 10 ? 1 : 0)}x`;
const leftText = (v) => (v >= 0 ? `${pct(v, 1)} left` : `overspent by ${pct(-v, 1)}`);
const int = (n) => n.toLocaleString('en-US'); // 8352 -> 8,352
// Chart coordinates. Numbers only, escaped anyway so every value takes the same path.
const num = (x) => esc((+x).toFixed(2));

// A length of time in words, one unit, rounded: "45 minutes", "3 hours".
function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const [n, unit] = s < 90 ? [s, 'second'] : s < 90 * 60 ? [Math.round(s / 60), 'minute']
    : s < 36 * 3600 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}
const ago = (ms) => `${span(ms)} ago`;

// One rule colours a day in the chart and a recent burn rate: good while it spends
// budget no faster than the SLO allows (burn rate up to 1), bad past 10 times that.
const toneOf = (burn) => (burn === null ? 'none' : burn <= 1 ? 'good' : burn <= 10 ? 'warn' : 'bad');
const LEVEL = { good: 'good', warn: 'missed the goal', bad: 'far below the goal', none: 'no data' };

// The badge is the newest probe only. Slow: it answered, but over the latency threshold.
// Stale: no probe for STALE_AFTER intervals, so the newest one no longer says
// anything about now. Grey, like no data, and never Up or Down.
const STATE = { up: ['good', 'Up'], slow: ['warn', 'Slow'], down: ['bad', 'Down'],
  stale: ['none', 'Stale'], none: ['none', 'Waiting'] };
function stateOf({ t, last }, now) {
  if (!last) return 'none';
  if (now - last.ts > STALE_AFTER * (DAY_MS / PER_DAY[t.cron])) return 'stale';
  if (!last.ok) return 'down';
  return last.ms > t.threshold ? 'slow' : 'up';
}

// A shape for every tone, so colour is never the only signal: check, triangle,
// cross in an octagon, and a dashed circle for no current data.
const ICON = {
  good: '<circle class="f" cx="8" cy="8" r="7.5"/><path class="g" d="M4.6 8.3l2.2 2.2 4.6-4.8"/>',
  warn: '<path class="f" d="M8 .9l7.4 13.6H.6z"/><path class="g" d="M8 5.8v3.9M8 12.2v.1"/>',
  bad: '<path class="f" d="M5.1 .9h5.8l4.2 4.2v5.8l-4.2 4.2H5.1L.9 10.9V5.1z"/><path class="g" d="M5.5 5.5l5 5m0-5l-5 5"/>',
  none: '<circle class="d" cx="8" cy="8" r="6.6"/>',
};
const icon = (tone) => `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${ICON[tone]}</svg>`;

// One headline for the whole page, worst news first.
function overall(stats, now) {
  const named = (s) => stats.filter((x) => stateOf(x, now) === s).map((x) => x.t.name);
  const [down, slow, stale, none] = [named('down'), named('slow'), named('stale'), named('none')];
  const count = (list, word) => `${list.length} service${list.length === 1 ? '' : 's'} ${word}`;
  const notes = [];
  if (down.length) notes.push(`Down: ${down.join(', ')}.`);
  if (slow.length) notes.push(`Slow: ${slow.join(', ')}.`);
  if (stale.length) notes.push(`Stale, no recent check: ${stale.join(', ')}.`);
  if (none.length && none.length < stats.length) notes.push(`Waiting for a first check: ${none.join(', ')}.`);
  if (none.length === stats.length) return { tone: 'none', head: 'Waiting for first checks', notes };
  if (down.length) return { tone: 'bad', head: count(down, 'down'), notes };
  if (slow.length) return { tone: 'warn', head: count(slow, 'slow'), notes };
  if (stale.length) return { tone: 'none', head: count(stale, 'stale'), notes };
  return { tone: 'good', head: none.length ? 'All checked services operational' : 'All services operational', notes };
}

// Everything the panels show for one service, worked out once.
function derive(s, now) {
  const { t, days, recent } = s;
  const state = stateOf(s, now);
  const perWindow = WINDOW_DAYS * PER_DAY[t.cron];
  const w = sum(days);
  const byDay = new Map(days.map((d) => [d.day, d]));
  // The window's UTC days, oldest first, each with its rollup row or null.
  const cal = Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const day = dayOf(now - (WINDOW_DAYS - 1 - i) * DAY_MS);
    return { day, d: byDay.get(day) ?? null };
  });
  const burn = (since) => {
    const r = recent.filter((p) => p.ts >= since);
    // Under BURN_MIN_PROBES one failure moves the rate in huge steps, so no number.
    return r.length < BURN_MIN_PROBES ? null : burnRate(r.length, r.filter((p) => !p.ok).length, t.slo);
  };
  return {
    ...s, state, tone: STATE[state][0], label: STATE[state][1], cal,
    checks: w.total, failed: w.total - w.good,
    avail: availability(w), lat: latency(w),
    left: w.total ? budgetRemaining(t.slo, perWindow, w.total - w.good) : null,
    series: burndown(cal.map(({ d }) => (d ? d.total - d.good : 0)), (1 - t.slo) * perWindow),
    p95: percentile(recent.filter((p) => p.ok).map((p) => p.ms), 95),
    burn24: burn(now - DAY_MS), burn1: burn(now - HOUR_MS),
    // Rolling hours ending now, so the last one is exactly the 1 h rate.
    hourly: hourlyBurn(recent, t.slo, now - DAY_MS, 24, BURN_MIN_PROBES),
  };
}

// The downtime allowance (error budget) in minutes, or hours once it is that big.
// Both numbers share the unit, so "33 of 43" compares at a glance.
function allowance(t, left) {
  const total = budgetMinutes(t.slo);
  const [div, unit, u] = total >= 120 ? [60, 'hours', 'h'] : [1, 'minutes', 'min'];
  const f = (m) => (m / div >= 10 ? Math.round(m / div) : +(m / div).toFixed(1));
  return { n: f(Math.abs(left) * total), total: f(total), unit, u };
}

// The allowance as a figure, a meter and a note. left: 1 untouched, 0 spent, below 0 overspent.
// value is HTML, so its parts are escaped here.
function budget(t, left) {
  if (left === null) return { tone: 'none', value: 'No data', bar: '', text: 'No checks in the window yet' };
  const a = allowance(t, left);
  if (left < 0) {
    return { tone: 'bad', value: `${esc(a.n)} <small>${esc(a.u)} over</small>`, bar: '<span class="over"></span>',
      text: `Overspent by ${pct(-left, 1)}` };
  }
  return { tone: left > 0.25 ? 'good' : left > 0 ? 'warn' : 'bad',
    value: `${esc(a.n)} <small>of ${esc(`${a.total} ${a.u}`)}</small>`,
    bar: `<span style="width:${num(left * 100)}%"></span>`, text: `${pct(left, 1)} of the budget left` };
}

// The first thing a visitor reads about a service, built from the same numbers as
// the panels under it, so the words and the numbers can never disagree.
function sentence(v, now) {
  const { t, last, left } = v;
  const fail = failingSince(v.recent);
  const head = {
    up: left > 0.25 && v.avail >= t.slo ? 'Healthy.' : 'Up.',
    slow: `Slow. The last check took ${dur(last.ms)}, over the ${dur(t.threshold)} goal.`,
    // A down state always has a recent failure; the fallback is for clock skew.
    down: fail ? `Down for ${fail.whole ? 'at least ' : ''}${span(now - fail.ts)}.` : 'Down.',
    stale: `No check for ${span(now - last.ts)}, so its current state is unknown.`,
  }[v.state];
  if (left === null) return head;
  const a = allowance(t, left);
  return `${head} ${left > 0
    ? `${pct(v.avail)} up over 30 days, ${a.n} of ${a.total} ${a.unit} of allowed downtime left.`
    : `It has used ${left < 0 ? 'more than its whole' : 'all of its'} downtime allowance for the last 30 days.`}`;
}

const note = (tone, text) => `<p class="s ${tone}">${icon(tone)}<span>${esc(text)}</span></p>`;
// A detail row for the SRE view. value is HTML.
const row = (label, term, value, extra = '') => `
      <div><dt>${esc(label)}${term ? ` <small>${esc(term)}</small>` : ''}</dt><dd><b>${value}</b>${extra}</dd></div>`;
// A smaller figure under a panel's headline one. value is HTML; tone adds its icon,
// and why is the hover text that says what the icon means.
const sub = (label, value, tone = '', why = '') => `
          <div><dt>${esc(label)}</dt><dd${tone ? ` class="${tone}"` : ''}${why ? ` title="${esc(why)}"` : ''}>${tone ? icon(tone) : ''}<b>${value}</b></dd></div>`;

// One SLO panel: a plain title with the SRE term small, its window, the headline
// figure and its verdict, two smaller figures with one line on what they mean, then
// the chart. The three parts sit on the row's subgrid, so a row's charts line up.
function pnl(cls, title, term, win, value, verdict, subs, hint, viz) {
  return `
      <div class="pnl ${cls}">
        <div class="top">
          <div class="ph"><h3>${esc(title)} <small>${esc(term)}</small></h3><span class="win">${esc(win)}</span></div>
          <p class="v${/^\d/.test(value) ? '' : ' word'}">${value}</p>${verdict}
        </div>
        <div class="sub"><dl>${subs}
        </dl><p class="hint">${hint}</p></div>${viz}
      </div>`;
}

// Every chart has the same frame: a caption, a lane of y labels on the left, the
// plot, and the window's ends under it. Plots are drawn in a 100 x 100 box stretched
// to the plot area, so the same numbers place the HTML labels as percentages.
// Strokes keep their width (vector-effect in the CSS), and labels never stretch.
// caption and body are HTML; ticks are [y %, text] pairs.
function chart(caption, ticks, body, ends, after = '') {
  return `
        <figure class="chart">
          <figcaption>${caption}</figcaption>
          <div class="plot">
            <div class="yax" aria-hidden="true">${ticks.map(([y, text]) => `<span style="top:${num(y)}%">${esc(text)}</span>`).join('')}</div>${body}
          </div>
          <div class="ends" aria-hidden="true">${ends.map((e) => `<span>${esc(e)}</span>`).join('')}</div>${after}
        </figure>`;
}
const noChart = (caption, why) => `
        <figure class="chart"><figcaption>${caption}</figcaption><p class="nodata">${esc(why)}</p></figure>`;

// 30 daily bars against the goal, oldest first. The scale runs from 100% down to
// five times the allowed failure rate, so the goal sits a fifth of the way down and a
// 99.95% day still looks nearly full. A day below that floor keeps a stub; its tooltip
// and the daily table give the number. A missed day is also a shorter bar, so the
// chart still reads without colour. The bars are hidden from screen readers: the key
// under them carries the same facts, and the table in the details every number.
function availChart(v) {
  const { t, cal } = v;
  const floor = 1 - 5 * (1 - t.slo);
  const y = (a) => (1 - Math.max(0, (a - floor) / (1 - floor))) * 100;
  const count = { good: 0, warn: 0, bad: 0, none: 0 };
  let worst = null;
  const bars = cal.map(({ day, d }) => {
    if (!d) {
      count.none++;
      return `<span class="none" title="${esc(day)}: no data"></span>`;
    }
    const a = d.good / d.total;
    const tone = toneOf(burnRate(d.total, d.total - d.good, t.slo));
    count[tone]++;
    if (tone !== 'good' && (!worst || a < worst.a)) worst = { day, a };
    return `<span class="${tone}" style="height:${num(100 - y(a))}%" title="${esc(`${day}: ${pct(a)} up, ${d.good} of ${d.total} checks, ${LEVEL[tone]}`)}"></span>`;
  }).join('');
  const key = Object.keys(count).filter((k) => count[k])
    .map((k) => `<span class="key"><i class="sw ${k}" aria-hidden="true"></i>${esc(`${count[k]} ${LEVEL[k]}`)}</span>`).join('');
  return { worst, chart: chart(`Each UTC day. Dashed: the ${esc(target(t.slo))} goal.`,
    [[0, '100%'], [y(t.slo), target(t.slo)], [100, target(floor)]], `
            <div class="area bars" aria-hidden="true">${bars}</div>
            <i class="goal" style="top:${num(y(t.slo))}%" aria-hidden="true"></i>`,
    [cal[0].day, 'Today'], `
          <p class="daysum">${key}</p>`) };
}

function burndownChart(v) {
  const { t, cal, series } = v;
  const cap = esc('What was left after each day. Dashed: spending it exactly on pace (1.0x).');
  if (v.left === null) return noChart(cap, 'No checks in the window yet.');
  const end = series[series.length - 1]; // the burndown only falls, so this is also the lowest point
  const lo = Math.min(0, end);
  // 100% on the top edge and the lowest point on the bottom one, like the other two charts.
  const y = (val) => ((1 - val) / (1 - lo)) * 100;
  const pts = [[0, y(1)], ...series.map((val, i) => [((i + 1) / WINDOW_DAYS) * 100, y(val)])];
  const line = `M${pts.map(([a, b]) => `${num(a)} ${num(b)}`).join('L')}`;
  const z = y(0);
  const area = `${line}L100 ${num(z)}L0 ${num(z)}Z`;
  const yEnd = num(y(end));
  const spent = cal[series.findIndex((val) => val <= 0)]?.day;
  const id = `${esc(t.id)}-bd`;
  const hits = cal.map(({ day, d }, i) => `<rect class="hit" x="${num((i * 100) / WINDOW_DAYS)}" y="0" width="${num(100 / WINDOW_DAYS)}" height="100">`
    + `<title>${esc(`${day}: ${d ? `${d.total - d.good} failed of ${d.total} checks` : 'no data'}, budget ${leftText(series[i])}`)}</title></rect>`).join('');
  const over = end < 0 ? ' bad' : '';
  return chart(cap, [[y(1), '100%'], [z, '0%']], `
            <div class="area">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-labelledby="${id}-t ${id}-d">
                <title id="${id}-t">Error budget left over the last 30 days</title>
                <desc id="${id}-d">${esc(`From 100% on ${cal[0].day} to ${leftText(end)} today.${spent ? ` It ran out on ${spent}.` : ''}`)}</desc>
                <defs>
                  <clipPath id="${id}-pos"><rect x="-5" y="-5" width="110" height="${num(z + 5)}"/></clipPath>
                  <clipPath id="${id}-neg"><rect x="-5" y="${num(z)}" width="110" height="${num(105 - z)}"/></clipPath>
                </defs>
                <path class="grid" d="M0 ${num(y(1))}H100"/>
                <path class="wash" d="${area}" clip-path="url(#${id}-pos)"/>
                <path class="wash bad" d="${area}" clip-path="url(#${id}-neg)"/>
                <path class="pace" d="M0 ${num(y(1))}L100 ${num(z)}"/>
                <path class="axis" d="M0 ${num(z)}H100"/>
                <path class="ln" d="${line}" clip-path="url(#${id}-pos)"/>
                <path class="ln bad" d="${line}" clip-path="url(#${id}-neg)"/>
                <path class="ring" d="M100 ${yEnd}h0"/><path class="dot${over}" d="M100 ${yEnd}h0"/>
                ${hits}
              </svg>
              <span class="lbl end${over}${y(end) < 30 ? ' below' : ''}" style="top:${yEnd}%" aria-hidden="true">${esc(leftText(end))}</span>
            </div>`, [cal[0].day, 'Today']);
}

function latencyChart(v, now) {
  const { t, recent } = v;
  const cap = `Each check, to the first response. Dashed: the ${esc(dur(t.threshold))} goal, slower is shaded. Red ticks: failed checks.`;
  if (!recent.length) return noChart(cap, 'No checks in the last 24 hours.');
  const start = now - DAY_MS;
  const good = recent.filter((r) => r.ok);
  const okMs = good.map((r) => r.ms);
  const top = Math.max(t.threshold * 1.25, ...okMs) * 1.1;
  const x = (ts) => Math.min(100, Math.max(0, ((ts - start) / DAY_MS) * 100));
  const y = (ms) => 100 - (ms / top) * 100;
  // A failed probe has no latency worth drawing, so the line breaks there.
  let line = '';
  let pen = 'M';
  for (const r of recent) {
    if (!r.ok) { pen = 'M'; continue; }
    line += `${pen}${num(x(r.ts))} ${num(y(r.ms))}`;
    pen = 'L';
  }
  const thr = y(t.threshold);
  const fails = recent.filter((r) => !r.ok).map((r) => `M${num(x(r.ts))} 100V88`).join('');
  // Hourly probes are few enough to mark one by one; 288 dots would be a smear.
  const dots = good.length && good.length <= 48 ? good.map((r) => `M${num(x(r.ts))} ${num(y(r.ms))}h0`).join('') : '';
  const id = `${esc(t.id)}-lt`;
  // One hover target per clock hour, so the tooltip finds the time, not a 2 px line.
  const firstHour = Math.floor(start / HOUR_MS) * HOUR_MS;
  const hits = Array.from({ length: 25 }, (_, h) => {
    const from = firstHour + h * HOUR_MS;
    const inHour = recent.filter((r) => r.ts >= from && r.ts < from + HOUR_MS);
    if (!inHour.length) return '';
    const ms = inHour.filter((r) => r.ok).map((r) => r.ms);
    const parts = [`${inHour.length} check${inHour.length === 1 ? '' : 's'}`];
    if (ms.length) parts.push(`median ${dur(percentile(ms, 50))}`, `slowest ${dur(Math.max(...ms))}`);
    if (ms.length < inHour.length) parts.push(`${inHour.length - ms.length} failed`);
    const x0 = x(from);
    return `<rect class="hit" x="${num(x0)}" y="0" width="${num(x(from + HOUR_MS) - x0)}" height="100">`
      + `<title>${esc(`${new Date(from).toISOString().slice(11, 16)} UTC: ${parts.join(', ')}`)}</title></rect>`;
  }).join('');
  const slow = okMs.filter((ms) => ms > t.threshold).length;
  const failed = recent.length - good.length;
  const summary = okMs.length
    ? `${recent.length} checks. Of the ${okMs.length} that answered: median ${dur(percentile(okMs, 50))}, p95 ${dur(v.p95)}, slowest ${dur(Math.max(...okMs))}, ${slow} over the ${dur(t.threshold)} goal. ${failed} failed.`
    : `${recent.length} checks, all failed.`;
  // Each line is written twice, clipped above and below the threshold. A <use> would
  // save the bytes, but Chrome then stretches its stroke despite non-scaling-stroke.
  return chart(cap, [[thr, dur(t.threshold)], [100, '0']], `
            <div class="area">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-labelledby="${id}-t ${id}-d">
                <title id="${id}-t">Response time over the last 24 hours</title>
                <desc id="${id}-d">${esc(summary)}</desc>
                <defs>
                  <clipPath id="${id}-hi"><rect x="-5" y="-5" width="110" height="${num(thr + 5)}"/></clipPath>
                  <clipPath id="${id}-lo"><rect x="-5" y="${num(thr)}" width="110" height="${num(105 - thr)}"/></clipPath>
                </defs>
                <rect class="band" x="0" y="0" width="100" height="${num(thr)}"/>
                <path class="axis" d="M0 100H100"/>
                <path class="thr" d="M0 ${num(thr)}H100"/>
                <path class="ln" d="${line}" clip-path="url(#${id}-lo)"/>
                <path class="ln warn" d="${line}" clip-path="url(#${id}-hi)"/>
                ${dots ? `<path class="ring" d="${dots}"/><path class="dot" d="${dots}" clip-path="url(#${id}-lo)"/><path class="dot warn" d="${dots}" clip-path="url(#${id}-hi)"/>` : ''}
                ${fails ? `<path class="fail" d="${fails}"/>` : ''}
                ${hits}
              </svg>
            </div>`, ['24 h ago', 'Now']);
}

// A trend with no axes, beside a summary figure: a quiet line, its newest point in the
// accent, null as a gap. The scale always reaches 0 and 1, which is the full budget for
// a burndown and the on-pace rate for a burn rate, so both read against their own mark.
function spark(vals, label) {
  const real = vals.filter((x) => x !== null);
  if (real.length < 2) return '';
  const lo = Math.min(0, ...real);
  const hi = Math.max(1, ...real);
  const y = (x) => 8 + ((hi - x) / (hi - lo)) * 84;
  let line = '';
  let pen = 'M';
  vals.forEach((x, i) => {
    if (x === null) { pen = 'M'; return; }
    line += `${pen}${num((i / (vals.length - 1)) * 100)} ${num(y(x))}`;
    pen = 'L';
  });
  const last = vals[vals.length - 1];
  const end = last === null ? '' : `<path class="ring" d="M100 ${num(y(last))}h0"/><path class="dot" d="M100 ${num(y(last))}h0"/>`;
  return `<svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">`
    + `<path class="axis" d="M0 ${num(y(0))}H100"/><path class="sl" d="${line}"/>${end}</svg>`;
}

const BURN = { good: 'Within the pace the SLO allows', warn: 'Faster than the SLO allows',
  bad: 'Over 10x the pace the SLO allows', none: 'Too few checks for a rate' };

// The top row: the worst service on each SLO number, so it says where to look first.
// Each tile links down to the service it names.
function summary(views) {
  const live = views.filter((v) => v.last);
  const f = fleet(live.map((v) => ({ v, avail: v.avail, slo: v.t.slo, left: v.left, burn: v.burn1 })));
  const up = views.filter((v) => v.state === 'up' || v.state === 'slow').length;
  const who = (x) => `<p class="who"><a href="#${esc(x.v.t.id)}">${esc(x.v.t.name)}</a></p>`;
  const tile = (title, term, value, extra, sp = '') => `
    <div class="kpi"><h3>${esc(title)} <small>${esc(term)}</small></h3>
      <div class="vrow"><p class="v${/^\d/.test(value) ? '' : ' word'}">${value}</p>${sp}</div>${extra}
    </div>`;

  const list = views.map((v) => `<li class="${v.tone}"><a href="#${esc(v.t.id)}">${icon(v.tone)}${esc(v.t.name)}</a><span>${esc(v.label)}</span></li>`).join('');
  const tiles = [tile('Services up', 'now', `${esc(up)} <small>of ${esc(views.length)}</small>`, `<ul class="fl">${list}</ul>`)];

  const low = f.lowest;
  tiles.push(low ? tile('Lowest up time', 'availability, 30 d', esc(pct(low.avail)),
    `${who(low)}${note(low.avail >= low.slo ? 'good' : 'bad', `${low.avail >= low.slo ? 'Meets' : 'Below'} its ${target(low.slo)} goal`)}`)
    : tile('Lowest up time', 'availability, 30 d', 'No data', note('none', 'No checks in the window yet')));

  const risk = f.atRisk;
  if (risk) {
    const b = budget(risk.v.t, risk.left).tone;
    const words = { good: 'Within budget', warn: 'Under a quarter left', bad: risk.left < 0 ? 'Overspent' : 'All used' };
    tiles.push(tile('Least allowance left', 'error budget', risk.left < 0
      ? `${esc(pct(-risk.left, 1))} <small>over</small>` : `${esc(pct(risk.left, 1))} <small>left</small>`,
    `${who(risk)}${note(b, words[b])}`, spark(risk.v.series, `Budget left after each day for ${risk.v.t.name}, last 30 days`)));
  } else {
    tiles.push(tile('Least allowance left', 'error budget', 'No data', note('none', 'No checks in the window yet')));
  }

  const hot = f.hottest;
  tiles.push(hot ? tile('Fastest spending, 1 h', 'burn rate', esc(rate(hot.burn)),
    `${who(hot)}${note(toneOf(hot.burn), BURN[toneOf(hot.burn)])}`,
    spark(hot.v.hourly, `Spending rate each hour for ${hot.v.t.name}, last 24 hours`))
    : tile('Fastest spending, 1 h', 'burn rate', 'No data', note('none', 'Too few checks in the last hour')));

  return `
  <section class="row" aria-labelledby="fleet">
    <h2 class="rowh" id="fleet">All services <small>the worst of each</small></h2>
    <div class="kpis">${tiles.join('')}
    </div>
  </section>`;
}

// The table twin of the daily chart and the burndown, newest day first. A scroll box,
// not a <details>: the 60 s reload would close a <details> while someone reads it.
function table(v) {
  const id = `${esc(v.t.id)}-dn`;
  const rows = v.cal.map(({ day, d }, i) => `<tr><td>${esc(day)}</td>${d
    ? `<td>${esc(d.total)}</td><td>${esc(d.total - d.good)}</td><td>${esc(pct(d.good / d.total))}</td>`
    : '<td colspan="3">No data</td>'}<td>${esc(pct(v.series[i], 1))}</td></tr>`).reverse().join('');
  return `
    <div class="raw">
      <h3 id="${id}">Daily numbers</h3>
      <div class="scroll" tabindex="0" role="region" aria-labelledby="${id}"><table>
        <thead><tr><th scope="col">Day, UTC</th><th scope="col">Checks</th><th scope="col">Failed</th><th scope="col">Up</th><th scope="col">Budget left</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}

// A service: its state and one sentence, then three panels (up time, the downtime
// allowance and response time), each a figure over its chart, then the SRE detail,
// rendered open when the URL says ?open=<id>. The selection lives in the query, which
// the meta refresh carries (see renderPage): a <details> closes on every reload, and a
// #fragment cannot survive one (Chromium drops a fragment added by a click, and a
// refresh to a URL with one never reloads). Each toggle is a page load; the #fragment
// on the Show link only scrolls to the service on that first load.
function service(v, now, open) {
  const { t, last } = v;
  const id = esc(t.id);
  const when = last && `<time datetime="${esc(new Date(last.ts).toISOString())}" title="${esc(stamp(last.ts))}">${esc(ago(now - last.ts))}</time>`;
  const toggles = last ? `
    <a class="toggle show" href="?open=${id}#${id}" aria-label="Show details for ${esc(t.name)}">Show details</a>
    <a class="toggle hide" href="/#${id}-top" aria-label="Hide details for ${esc(t.name)}">Hide details</a>` : '';
  const head = `
  <header class="shead" id="${id}-top">
    <span class="pill ${v.tone}">${icon(v.tone)}${v.label}</span>
    <h2>${esc(t.name)}</h2>
    <a class="host" href="${esc(t.url)}" rel="noopener noreferrer">${esc(new URL(t.url).host)}</a>
    <p class="when">${last ? `Checked ${when} &middot; ` : ''}${esc(EVERY[t.cron] ?? t.cron)}</p>${toggles}
  </header>`;

  if (!last) {
    // Cloudflare crons fire on the clock, so the next run is the next multiple.
    // A GitHub run reports back a varying time after it is started, so no number for it.
    const every = DAY_MS / PER_DAY[t.cron];
    const wait = Math.max(1, Math.round((Math.ceil(now / every) * every - now) / 60_000));
    const next = t.source ? 'after the next GitHub Actions run' : `in about ${wait} min`;
    return `
<section class="svc none" id="${id}">${head}
  <div class="empty">
    <p><b>No checks yet.</b> ${esc(t.name)} is checked ${esc(EVERY[t.cron] ?? t.cron)}, so the first result should arrive ${esc(next)}.</p>
    <p>It will be held to ${esc(target(t.slo))} availability, with ${esc(target(t.latencySlo))} of good checks answering within ${esc(dur(t.threshold))}.</p>
  </div>
</section>`;
  }

  const availTone = v.avail === null ? 'none' : v.avail >= t.slo ? 'good' : 'bad';
  const b = budget(t, v.left);
  const [nowValue, nowTone, nowNote] = {
    up: [dur(last.ms), 'good', `Under the ${dur(t.threshold)} goal`],
    slow: [dur(last.ms), 'warn', `Over the ${dur(t.threshold)} goal`],
    down: [last.status === null ? 'No answer' : `HTTP ${last.status}`, 'bad', 'The last check failed'],
    stale: [last.ok ? dur(last.ms) : 'Failed', 'none', 'Out of date'],
  }[v.state];
  const h = availChart(v);
  const b24 = toneOf(v.burn24);
  const b1 = toneOf(v.burn1);
  const latTone = v.lat === null ? 'none' : v.lat >= t.latencySlo ? 'good' : 'bad';
  const result = last.status === null ? esc(last.err) : `HTTP ${esc(last.status)} in ${esc(dur(last.ms))}`;
  const goal = (x, g, what) => (x === null ? note('none', 'No data yet')
    : note(x >= g ? 'good' : 'bad', `${x >= g ? 'Meets' : 'Below'} the ${target(g)} ${what}`));

  return `
<section class="svc ${v.tone}${open ? ' open' : ''}" id="${id}">${head}
  <p class="lead">${esc(sentence(v, now))}</p>
  <div class="panels">${pnl('av', 'Up time', 'availability', '30 d',
    esc(v.avail === null ? 'No data' : pct(v.avail)), goal(v.avail, t.slo, 'goal'),
    sub('Checks', esc(int(v.checks))) + sub('Failed', esc(int(v.failed))),
    `A check is up when the site answers with a 2xx status within ${esc(dur(t.timeout))}.`, h.chart)}${pnl('bd opt', 'Downtime allowance', 'error budget', '30 d',
    b.value, `<div class="meter ${b.tone}" aria-hidden="true">${b.bar}</div>${note(b.tone, b.text)}`,
    sub('Spending rate, 24 h', esc(v.burn24 === null ? 'No data' : rate(v.burn24)), b24, BURN[b24])
      + sub('Spending rate, 1 h', esc(v.burn1 === null ? 'No data' : rate(v.burn1)), b1, BURN[b1]),
    'Burn rate. 1.0x = on pace to use the whole allowance in exactly 30 days; 10x would use it in 3.', burndownChart(v))}${pnl('lt opt', 'Response time', 'newest check', '24 h',
    esc(nowValue), note(nowTone, nowNote),
    sub('95% answered within', esc(v.p95 === null ? 'No data' : dur(v.p95)))
      + sub(`Under ${dur(t.threshold)}, 30 d`, esc(v.lat === null ? 'No data' : pct(v.lat)), latTone,
        `${latTone === 'none' ? 'No data' : latTone === 'good' ? 'Meets' : 'Below'} the ${target(t.latencySlo)} latency target`),
    `p95, 24 h: 95% of answered checks were this fast or faster. Latency SLI, 30 d: the share of answered checks under ${esc(dur(t.threshold))}.`, latencyChart(v, now))}
  </div>
  <div class="more">
    <dl class="minor">${row('Last check', '', result, `<p class="s">${esc(stamp(last.ts))}</p>`)}${row('Checked', '', esc(EVERY[t.cron] ?? t.cron),
      `<p class="s">From ${t.source ? 'GitHub Actions, started by this monitor' : 'Cloudflare'}</p>`)}${row('Days with data', '',
      esc(`${v.cal.filter(({ d }) => d).length} of ${WINDOW_DAYS}`),
      h.worst ? `<p class="s">${esc(`Worst: ${h.worst.day}, ${pct(h.worst.a)} up`)}</p>` : '')}
    </dl>${v.left === null ? '' : table(v)}
  </div>
</section>`;
}

// Favicon dot in the overall tone. Hex is spelled out: a data: URI cannot read CSS variables.
const DOT = { good: '249c74', warn: 'b6770b', bad: '9a2b19', none: '8a8273' };
const favicon = (tone) => "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E"
  + `%3Ccircle cx='8' cy='8' r='7' fill='%23${DOT[tone]}'/%3E%3C/svg%3E`;
const CAL = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>';

// open: the ?open= value. Only a known id gets through, so nothing else reaches the page.
function renderPage(stats, now, open = null) {
  const sel = open === 'how' || TARGETS.some((t) => t.id === open) ? open : null;
  // The refresh names its URL, with the selection and no #fragment. A bare refresh
  // reuses the page's URL, and Chromium treats a URL with a fragment as a jump within
  // the page: it scrolls back to the fragment and never loads new data.
  const again = sel ? `/?open=${sel}` : '/';
  const views = stats.map((s) => derive(s, now));
  const { tone, head, notes } = overall(views, now);
  // source is only ever 'github' for now.
  const probed = TARGETS.map((t) => `<li>${esc(new URL(t.url).host)}: ${esc(EVERY[t.cron] ?? t.cron)}`
    + ` from ${t.source ? 'GitHub Actions, started by this monitor, with GitHub&rsquo;s own schedule as a backup'
      : 'Cloudflare'}, ${esc(dur(t.timeout))} timeout</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="60; url=${esc(again)}">
<title>${esc(head)} | Uptime and SLOs</title>
<link rel="icon" href="${favicon(tone)}">
<style>
  /* Paper and ink from theoith.ink, stepped toward neutral so the status colours stand
     out, with the site's monospace for machine strings (hosts, dates, UTC times). */
  :root {
    --sans: system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace;
    --gut: 44px; /* the y-label lane of every chart */
    --bg: #f3f1ec; --card: #fdfcfa; --raised: #f6f4ef; --line: #e2ddd3; --grid: #ece8e0; --axis: #b5ad9e;
    --text: #1c1a17; --muted: #5e584e;
    /* One accent, on data and focus only. The accent and the three status hues were
       checked as one set: every pair apart under protan and deutan simulation and to
       normal vision, each mark 3:1 on a panel (--none too: it marks a day with no data).
       Each -ink is the 4.5:1 text shade. */
    --accent: #2672b7;
    --good: #249c74; --good-ink: #17704f; --warn: #b6770b; --warn-ink: #845300;
    --bad: #9a2b19; --bad-ink: #9a2b19; --none: #8a8376; --none-ink: #5e584e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e0d0b; --card: #171613; --raised: #1f1d1a; --line: #2a2824; --grid: #23211d; --axis: #4d4840;
      --text: #f2ead9; --muted: #a8a193; --accent: #4a8fd8;
      --good: #36a980; --good-ink: #6dcfa6; --warn: #bb881a; --warn-ink: #e3b15a;
      --bad: #c1351e; --bad-ink: #f08a74; --none: #716b62; --none-ink: #a8a193;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); overflow-wrap: break-word;
    font: 14px/1.45 var(--sans); -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1440px; margin: 0 auto; padding: 0 32px 48px; }
  p { margin: 0; }
  a { color: inherit; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); }
  a:hover { text-decoration-color: currentColor; }
  a:focus-visible, .scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  /* The technical term next to a plain label: there for an SRE, quiet for everyone else. */
  small { font-size: .85em; font-weight: 400; color: var(--muted); white-space: nowrap; }
  h1, h2, h3 { margin: 0; line-height: 1.25; }
  h1 { font-size: 24px; font-weight: 650; letter-spacing: -.015em; }
  h2 { font-size: 20px; font-weight: 650; letter-spacing: -.01em; }
  h3 { font-size: 13px; font-weight: 600; }
  .sub-t, .crumb, .when, .host, dt, .ends, .daysum, .hint, .meta, figcaption, footer, .nodata, .yax, .win { color: var(--muted); }
  .host, .win, .meta time, .ends, .yax, td:first-child { font-family: var(--mono); font-size: 12px; }
  .v, .sub dd, .yax, table, .when { font-variant-numeric: tabular-nums; }

  /* One tone per state. --c is the mark, --ci the text shade, --on the glyph inside an icon. */
  .good { --c: var(--good); --ci: var(--good-ink); --on: var(--card); }
  .warn { --c: var(--warn); --ci: var(--warn-ink); --on: #1c1a17; }
  .bad { --c: var(--bad); --ci: var(--bad-ink); --on: var(--card); }
  .none { --c: var(--none); --ci: var(--none-ink); --on: var(--card); }
  .icon { flex: none; width: 1em; height: 1em; }
  .icon .f { fill: var(--c); }
  .icon .g { fill: none; stroke: var(--on); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .icon .d { fill: none; stroke: var(--ci); stroke-width: 1.6; stroke-dasharray: 2.6 2.1; }
  .ic { width: 14px; height: 14px; fill: none; stroke: var(--muted); stroke-width: 1.4; stroke-linecap: round; }

  /* 1. The header bar: title, the window, live, then the whole page in words. */
  .bar { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px; padding: 24px 0 16px; }
  .crumb { display: flex; gap: 6px; font-size: 13px; margin-bottom: 4px; }
  .crumb a { color: var(--text); font-weight: 600; text-decoration: none; }
  .crumb a:hover { text-decoration: underline; }
  .sub-t { margin-top: 2px; font-size: 13px; }
  .ctl { display: flex; flex-wrap: wrap; gap: 8px; }
  /* Readouts in the shape of controls, the way an ops dashboard shows its scope. */
  .chip { position: relative; display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px;
    border: 1px solid var(--line); border-radius: 6px; background: var(--card); font-size: 13px; white-space: nowrap; overflow: hidden; }
  .live { color: var(--muted); }
  .live b { color: var(--text); font-weight: 600; }
  /* The dot is the text shade of the overall tone, so it clears 3:1 in every state. */
  .live i { position: relative; width: 8px; height: 8px; border-radius: 50%; background: var(--ci); }
  /* Drains over the 60 s until the meta refresh. Shown only with motion on. */
  .tick { display: none; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--line); }
  .tick::before { content: ""; display: block; height: 100%; background: var(--muted); transform-origin: left; }
  .banner { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding: 12px 16px; border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c) 40%, var(--line)); background: color-mix(in srgb, var(--c) 9%, var(--card)); }
  .banner h2 { display: flex; align-items: center; gap: 8px; font-size: 16px; }
  .banner .meta { margin-left: auto; font-size: 13px; }

  /* 2. Rows of panels. One gutter (16 px), one radius (8 px), hairline edges. */
  .row { margin-top: 28px; }
  .rowh { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
  .kpi, .pnl { min-width: 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
  .kpi { display: grid; align-content: start; gap: 6px; }
  .vrow { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 4px 12px; }
  .v { font-size: 28px; font-weight: 600; line-height: 1.15; letter-spacing: -.02em; }
  .v small { font-size: 14px; font-weight: 500; letter-spacing: 0; }
  /* A value that is words, not a number ("No answer"), is set smaller in the same line height. */
  .v.word { font-size: 20px; line-height: 1.6; letter-spacing: -.01em; }
  .who { font-size: 13px; font-weight: 600; }
  .fl { list-style: none; margin: 2px 0 0; padding: 0; display: grid; gap: 2px; font-size: 13px; }
  .fl li { display: flex; justify-content: space-between; gap: 8px; }
  .fl a { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; }
  .fl a:hover { text-decoration: underline; }
  .fl span { color: var(--muted); }
  .spark { width: 96px; height: 34px; overflow: visible; }
  .spark path { fill: none; vector-effect: non-scaling-stroke; }
  .spark .sl { stroke: var(--muted); stroke-width: 1.5; stroke-linejoin: round; }
  .spark .dot { stroke: var(--accent); stroke-width: 7; stroke-linecap: round; }
  .spark .ring { stroke: var(--card); stroke-width: 11; stroke-linecap: round; }

  .s { display: flex; align-items: flex-start; gap: 6px; font-size: 13px; line-height: 1.35; color: var(--muted); }
  .s .icon { margin-top: .1em; }
  .s.good, .s.warn, .s.bad { color: var(--ci); font-weight: 600; }

  /* 3. A service: state, one sentence, three panels. */
  .svc { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line); scroll-margin-top: 12px; }
  .shead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; scroll-margin-top: 12px; }
  .when { margin-left: auto; font-size: 13px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; white-space: nowrap;
    font-size: 13px; font-weight: 650; color: var(--ci); background: color-mix(in srgb, var(--c) 14%, var(--card));
    border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); }
  .lead { margin: 10px 0 16px; font-size: 16px; max-width: 75ch; }
  .panels { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
  /* Each panel spans three rows of the panel grid (figure, smaller figures, chart),
     so the smaller figures and the charts start on one line across a row. */
  .pnl { display: grid; grid-row: span 3; grid-template-rows: subgrid; }
  .top { display: grid; align-content: start; gap: 4px; }
  .ph { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .top .v { margin-top: 4px; }
  .sub { display: grid; align-content: start; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); }
  .sub dl { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0; }
  .sub dt, .minor dt { font-size: 12px; }
  .sub dd { display: flex; align-items: center; gap: 6px; margin: 2px 0 0; font-size: 16px; }
  .sub dd b { font-weight: 600; }
  .hint { font-size: 12px; }
  /* The track is a pale step of the fill's own tone, so the state reads across the whole bar. */
  .meter { height: 8px; margin: 6px 0 4px; border-radius: 999px; overflow: hidden;
    background: color-mix(in srgb, var(--c) 18%, var(--raised)); }
  .meter span { display: block; height: 100%; border-radius: 999px; background: var(--c); }
  /* Overspent: a full bar, striped, so it does not read as a full budget. */
  .meter .over { width: 100%; background: repeating-linear-gradient(135deg, var(--bad) 0 6px, transparent 6px 10px); }

  .chart { margin: 0; min-width: 0; display: grid; align-content: start; gap: 6px; }
  /* Two lines held for every caption, so the plots of a row start on one line. */
  figcaption { font-size: 12px; min-height: calc(2 * 1.45em); }
  .plot { position: relative; height: 128px; margin: 8px 0 2px; }
  .yax span { position: absolute; left: 0; width: calc(var(--gut) - 8px); text-align: right; transform: translateY(-50%); line-height: 1; }
  .area { position: absolute; inset: 0 0 0 var(--gut); }
  .area svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .area path { fill: none; vector-effect: non-scaling-stroke; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { stroke: var(--axis); stroke-width: 1; }
  /* Dashed only for reference lines (goal, pace), never for grid or axes. */
  .pace, .thr { stroke: var(--muted); stroke-width: 1.25; stroke-dasharray: 4 4; }
  .ln { stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .ln.warn, .dot.warn { stroke: var(--warn); }
  .ln.bad, .dot.bad, .fail { stroke: var(--bad); }
  .area .wash { fill: var(--accent); fill-opacity: .1; }
  .area .wash.bad { fill: var(--bad); fill-opacity: .16; }
  .area .band { fill: var(--warn); fill-opacity: .08; }
  .ring { stroke: var(--card); stroke-width: 12; stroke-linecap: round; }
  .dot { stroke: var(--accent); stroke-width: 8; stroke-linecap: round; }
  .fail { stroke-width: 2; }
  .hit { fill: transparent; }
  .hit:hover { fill: color-mix(in srgb, var(--text) 8%, transparent); }
  .lbl { position: absolute; right: 0; padding: 0 0 2px 4px; transform: translateY(calc(-100% - 8px)); font-size: 12px; line-height: 1.2;
    font-weight: 650; white-space: nowrap; background: color-mix(in srgb, var(--card) 85%, transparent); pointer-events: none; }
  .lbl.below { transform: translateY(8px); }
  .lbl.bad { color: var(--bad-ink); }
  .ends { display: flex; justify-content: space-between; margin-left: var(--gut); }
  .nodata { font-size: 13px; padding: 48px 0; text-align: center; border: 1px dashed var(--line); border-radius: 6px; }

  /* The daily bars: the goal is a dashed line drawn over them, so a short day shows
     how far it fell, and the baseline is the one solid rule. */
  .bars { display: grid; grid-template-columns: repeat(${WINDOW_DAYS}, 1fr); align-items: end; gap: 2px; border-bottom: 1px solid var(--axis); }
  .bars span { min-height: 3px; border-radius: 2px 2px 0 0; background: var(--c); }
  .bars span:hover { box-shadow: 0 0 0 2px var(--card), 0 0 0 3px var(--text); }
  /* No data is hollow and dashed, like the no-data icon, so it is not a colour to learn. */
  .bars .none, .sw.none { background: transparent; border: 1px dashed var(--none); }
  .bars .none { height: 100%; border-bottom: 0; }
  .goal { position: absolute; left: var(--gut); right: 0; border-top: 1.5px dashed var(--text); opacity: .75; pointer-events: none; }
  .daysum { display: flex; flex-wrap: wrap; gap: 2px 14px; margin-top: 4px; font-size: 12px; }
  .key { white-space: nowrap; }
  .sw { display: inline-block; width: 9px; height: 12px; margin-right: 5px; border-radius: 2px; vertical-align: -1px; background: var(--c); }

  /* 4. The SRE detail, one service at a time, open when the server marks it .open. */
  .toggle { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border-radius: 6px;
    border: 1px solid var(--line); background: var(--card); font-size: 13px; font-weight: 600; text-decoration: none; }
  .toggle::after { content: ""; width: 6px; height: 6px; border: solid currentColor; border-width: 0 1.5px 1.5px 0;
    transform: translateY(-2px) rotate(45deg); }
  .toggle.hide::after { transform: translateY(2px) rotate(-135deg); }
  .toggle:hover { background: var(--raised); border-color: var(--axis); }
  .more, .hide { display: none; }
  .open .show { display: none; }
  .open .hide { display: inline-flex; }
  .open .more { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 16px; margin-top: 16px; align-items: start; }
  .minor { display: grid; gap: 14px; margin: 0; padding: 16px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  dd { display: grid; gap: 2px; margin: 2px 0 0; }
  .minor dd b { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
  .raw h3 { margin-bottom: 8px; }
  .scroll { max-height: 16rem; overflow: auto; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: right; padding: 6px 16px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { position: sticky; top: 0; font-weight: 600; font-size: 12px; color: var(--muted); background: var(--card); }

  .empty { display: grid; gap: 6px; margin-top: 16px; padding: 16px; border-radius: 8px; font-size: 14px;
    color: var(--muted); border: 1px dashed var(--axis); }
  .empty b { color: var(--text); }

  /* 5. How it is measured, at the bottom, opened the same way as a service's detail. */
  footer { display: grid; justify-items: start; gap: 12px; font-size: 13px; border-top: 1px solid var(--line);
    margin-top: 40px; padding-top: 20px; scroll-margin-top: 12px; }
  footer.open .more { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-top: 0; max-width: 80ch; }
  footer ul { margin: 0; padding-left: 20px; }
  footer .back { font-weight: 600; }

  @media (max-width: 1099px) {
    .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .panels { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .pnl.lt { grid-column: 1 / -1; }
  }
  @media (max-width: 760px) {
    .wrap { padding: 0 16px 32px; }
    .panels { grid-template-columns: minmax(0, 1fr); }
    /* One column: no row to line up with, so each panel is a plain stack. */
    .pnl { display: grid; grid-row: auto; grid-template-rows: none; gap: 14px; }
    .open .more { grid-template-columns: minmax(0, 1fr); }
    /* Progressive disclosure on a phone: the daily chart stays, the burndown and the
       response-time chart come with the details. */
    .svc:not(.open) .opt .chart { display: none; }
  }
  @media (max-width: 560px) {
    h1 { font-size: 22px; }
    h2 { font-size: 18px; }
    .bar { padding-top: 16px; }
    .kpis { gap: 12px; }
    .kpi { padding: 12px; }
    .v { font-size: 24px; }
    .v.word { font-size: 18px; }
    .spark { width: 100%; height: 28px; }
    .when { margin-left: 0; flex-basis: 100%; }
    .banner .meta { margin-left: 0; }
    .toggle { height: 40px; } /* a thumb-sized target */
    .pnl { padding: 14px; }
    .bars { gap: 1px; }
  }

  /* Motion, only for people who have not asked for less. Every entrance animates
     from a start state back to the resting style, so with motion off the page is
     already complete. The page reloads every minute and the entrances replay, so
     each is under 0.8 s and only on marks that carry data: a replay reads as fresh
     numbers arriving, and the chrome around them stays still. */
  @media (prefers-reduced-motion: no-preference) {
    html { scroll-behavior: smooth; }
    .tick { display: block; }
    .tick::before { animation: drain 60s linear forwards; }
    /* Three beats after each load, only when everything is up. Under 5 s, so it
       stays clear of WCAG 2.2.2, which asks for a pause control on longer motion. */
    .live.good i::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: inherit;
      animation: ping 1.5s ease-out 3 both; }
    .v { animation: rise-in .45s ease-out backwards; }
    .kpi + .kpi .v, .pnl + .pnl .v { animation-delay: 60ms; }
    .kpi + .kpi + .kpi .v, .pnl + .pnl + .pnl .v { animation-delay: 120ms; }
    .kpi + .kpi + .kpi + .kpi .v { animation-delay: 180ms; }
    .meter span { transform-origin: left; animation: grow .8s cubic-bezier(.2, .8, .2, 1) .15s backwards; }
    /* Oldest day first, so the wave ends on today. sibling-index() is newer than the
       rest; where it is missing, every bar rises at once. */
    .bars span { transform-origin: bottom; animation: lift .4s cubic-bezier(.2, .8, .2, 1) backwards;
      animation-delay: calc(sibling-index() * 10ms); transition: transform .15s ease-out; }
    .bars span:hover { transform: scaleY(1.06); }
    .open .more { animation: rise-in .3s ease-out backwards; }
    /* A wipe, not stroke-dashoffset: non-scaling-stroke measures dashes on screen,
       so a dash-based draw-in would end at a different length on every chart width. */
    .area svg, .spark { animation: wipe .8s cubic-bezier(.4, 0, .2, 1) .1s backwards; }
    .area .lbl { animation: fade .3s ease-out .6s backwards; }
    .hit { transition: fill .15s; }
    .toggle { transition: background-color .15s, border-color .15s; }
  }
  @keyframes drain { to { transform: scaleX(0); } }
  @keyframes ping { from { opacity: .6; } to { transform: scale(3); opacity: 0; } }
  @keyframes rise-in { from { opacity: 0; transform: translateY(6px); } }
  @keyframes grow { from { transform: scaleX(0); } }
  @keyframes lift { from { transform: scaleY(0); } }
  /* The plot overflows its box (end dots, ticks), so the open end is past every edge. */
  @keyframes wipe { from { clip-path: inset(-20px 100% -20px -20px); } to { clip-path: inset(-20px); } }
  @keyframes fade { from { opacity: 0; } }
</style>
</head>
<body>
<div class="wrap">
<header class="bar">
  <div>
    <p class="crumb"><a href="https://theoith.ink/">theoith.ink</a><span aria-hidden="true">/</span><span>status</span></p>
    <h1>Uptime and SLOs</h1>
    <p class="sub-t">Whether my sites are up right now, and how reliable they have been over the last 30 days.</p>
  </div>
  <div class="ctl">
    <p class="chip">${CAL}<span>Last 30 days</span></p>
    <p class="chip live ${tone}"><i aria-hidden="true"></i><b>Live</b><span>Refreshes every minute</span><span class="tick" aria-hidden="true"></span></p>
  </div>
</header>
<main>
  <section class="banner ${tone}" aria-labelledby="overall">
    <h2 id="overall">${icon(tone)}${esc(head)}</h2>
    ${notes.length ? `<p>${esc(notes.join(' '))}</p>` : ''}
    <p class="meta">Updated <time datetime="${esc(new Date(now).toISOString())}">${esc(stamp(now))}</time></p>
  </section>
  ${summary(views)}
  ${views.map((v) => service(v, now, sel === v.t.id)).join('')}
</main>
<footer id="how"${sel === 'how' ? ' class="open"' : ''}>
  <p id="how-top">The two Cloudflare-hosted sites are checked from Cloudflare, so this page shares fate with them:
    a Cloudflare outage can take those sites, this page and the alerts down together.</p>
  ${PAUSED.map((t) => `<p>Paused: ${esc(t.name)} (${esc(new URL(t.url).host)}). ${esc(t.why)}</p>`).join('')}
  <a class="toggle show" href="?open=how#how">How this is measured</a>
  <a class="toggle hide" href="/#how-top">Hide how this is measured</a>
  <div class="more">
    <p>A check (a probe) is up when the site answers 2xx within the timeout.
      The badge on each service is its newest check. Slow means it answered, but slower than its response-time goal.
      Stale means no check has arrived for ${esc(STALE_AFTER)} of its intervals, so its current state is unknown.</p>
    <ul>${probed}</ul>
    <p>Up time (availability) is good checks out of all checks over the last 30 UTC days. The downtime allowance
      (error budget) is how many checks may fail in a full 30-day window, (1 &minus; SLO) &times; the window's checks,
      shown as minutes of downtime: 99.9% allows 43.2 minutes. A failure on day one costs what it would on day 30.
      Spending rate (burn rate) is the failure rate over a recent window divided by the rate the SLO allows:
      1.0x would use the allowance in exactly 30 days.</p>
    <p>The two Cloudflare-hosted sites are checked by a Cloudflare Cron Trigger, from whichever Cloudflare data center
      picks up the job. That means this monitor shares fate with them: if Cloudflare has an outage,
      those sites and this page can go down together, and no alert goes out.</p>
    <p>Hulog is checked every hour by a GitHub Actions job, which sends each result here. The bot check in front of
      onrender.com blocks requests from Cloudflare Workers, so a check from Cloudflare would measure that block, not Hulog.
      This monitor starts the job, because GitHub&rsquo;s own schedule often ran late or not at all; that schedule stays
      as a backup. A skipped hour is missing data, not a failure.</p>
  </div>
  <p><a class="back" href="https://theoith.ink/">&larr; theoith.ink</a></p>
</footer>
</div>
</body>
</html>`;
}

function text(body, status, extra = {}) {
  return new Response(body, { status, headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8', ...extra } });
}

// ---------- results from probes outside Cloudflare ----------

// Hashing both sides first gives two equal-length values, so the loop below
// takes the same time wherever they differ and leaks nothing about the length.
// Node has no crypto.subtle.timingSafeEqual, so this works in tests and workerd alike.
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async (s) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function ingest(request, env) {
  const no = (why, status = 400, extra) => text(`${why}\n`, status, extra);
  // No secret means nobody can be checked, so nothing is accepted.
  if (!env.INGEST_TOKEN) return no('Ingest is not configured', 503);
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ') || !(await sameSecret(auth.slice(7), env.INGEST_TOKEN))) {
    return no('Unauthorized', 401, { 'www-authenticate': 'Bearer' });
  }

  // Content-Length can be missing or wrong, so the real length is checked too.
  // ponytail: the body is read whole before that check; only token holders get here.
  const tooBig = `Body over ${INGEST_MAX_BYTES} bytes`;
  if (Number(request.headers.get('content-length')) > INGEST_MAX_BYTES) return no(tooBig, 413);
  const raw = await request.arrayBuffer();
  if (raw.byteLength > INGEST_MAX_BYTES) return no(tooBig, 413);
  let b;
  try {
    b = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return no('Body is not JSON');
  }

  if (typeof b !== 'object' || b === null || Array.isArray(b)) return no('Body must be a JSON object');
  if (Object.keys(b).some((k) => !INGEST_FIELDS.includes(k))) {
    return no(`Only these fields are allowed: ${INGEST_FIELDS.join(', ')}`);
  }
  if (typeof b.target !== 'string') return no('target must be a string');
  const t = EXTERNAL.get(b.target);
  if (!t) return no('Unknown target', 404);
  if (typeof b.ok !== 'boolean') return no('ok must be true or false');
  if (b.status !== null && !(Number.isInteger(b.status) && b.status >= 100 && b.status <= 599)) {
    return no('status must be an integer from 100 to 599, or null');
  }
  if (!(Number.isInteger(b.ms) && b.ms >= 0 && b.ms <= t.timeout)) return no(`ms must be an integer from 0 to ${t.timeout}`);
  if (b.err !== null && !(typeof b.err === 'string' && b.err.length <= 200)) {
    return no('err must be a string of at most 200 characters, or null');
  }
  // Same meaning as a probe from here: up is a 2xx, and no response needs a reason.
  if (b.ok && !(b.status >= 200 && b.status <= 299)) return no('ok true needs a 2xx status');
  if (b.status === null && b.err === null) return no('status null needs an err');

  // The Worker's clock, not the sender's, so a token cannot backdate or reorder history.
  const r = { ts: Date.now(), ok: b.ok, status: b.status, ms: b.ms, err: b.err };
  if (!(await record(env, t, r, INGEST_QUIET_MS))) {
    return no(`${t.id} already has a probe from the last ${INGEST_QUIET_MS / 60_000} minutes`, 429);
  }
  console.log(`${t.id} (${t.source}): ${r.ok ? 'up' : 'down'}, ${r.status ?? r.err}, ${r.ms} ms`);
  await alertIfChanged(env, t, r);
  return new Response(null, { status: 204, headers: HEADERS });
}

export default {
  async scheduled(controller, env) {
    // Hulog's hour only starts its GitHub run. The sites have their own */5 invocation,
    // which Cloudflare fires separately, even at minute 5.
    if (controller.cron === EXTERNAL.get('hulog').cron) return startHulogProbe(env);
    // Never probe an external target from here: that is the request the bot check blocks.
    const due = TARGETS.filter((t) => !t.source && t.cron === controller.cron);
    if (due.length === 0) console.warn(`no targets for cron "${controller.cron}"`);
    // allSettled, so one target failing never stops another being recorded.
    const results = await Promise.allSettled(due.map(async (t) => {
      const r = await probe(t);
      if (!(await record(env, t, r))) throw new Error(`${t.id}: not recorded, a newer probe exists`);
      console.log(`${t.id}: ${r.ok ? 'up' : 'down'}, ${r.status ?? r.err}, ${r.ms} ms`);
      await alertIfChanged(env, t, r);
    }));
    const failed = results.filter((x) => x.status === 'rejected').map((x) => x.reason);
    if (failed.length) throw new AggregateError(failed, 'could not record probe results');
  },

  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === '/ingest') {
      if (request.method !== 'POST') return text('Method not allowed\n', 405, { allow: 'POST' });
      return ingest(request, env);
    }
    if (pathname !== '/') return text('Not found\n', 404);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text('Method not allowed\n', 405, { allow: 'GET, HEAD' });
    }
    const now = Date.now();
    const html = renderPage(await loadStats(env, now), now, searchParams.get('open'));
    return new Response(html, { headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8' } });
  },
};
