import {
  FAILS_BEFORE_ALERT, sum, availability, latency,
  budgetRemaining, budgetMinutes, percentile, alertFor, burnRate, burndown,
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
  // The cron is the schedule in .github/workflows/probe-hulog.yml.
  { id: 'hulog', name: 'Hulog', url: 'https://hulog.onrender.com/', source: 'github',
    cron: '7 * * * *', timeout: 90_000, threshold: 60_000, slo: 0.99, latencySlo: 0.95 },
];
// The only targets /ingest accepts. Anything else is a 404.
const EXTERNAL = new Map(TARGETS.filter((t) => t.source).map((t) => [t.id, t]));
// Not probed and not shown as a panel; the page footer names each one and its
// `why`. Empty for now. A paused target keeps its settings so it can move back.
const PAUSED = [];
// Must match the crons in wrangler.toml, or the workflow for an external target.
const EVERY = { '*/5 * * * *': 'every 5 minutes', '7 * * * *': 'every hour' };
// Probes per day for each cron. The error budget is counted against a full
// window of probes, so a failure on day one costs what it would on day 30.
const PER_DAY = { '*/5 * * * *': 288, '7 * * * *': 24 };
// A target is Stale when its newest probe is older than this many intervals.
// External probes can stop without an error here: GitHub delays or skips
// scheduled runs, and turns off schedules in a repo with no activity for 60 days.
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
const dur = (ms) => (ms < 10_000 ? `${ms} ms` : `${+(ms / 1000).toFixed(1)} s`);
const stamp = (ts) => `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const rate = (x) => `${x.toFixed(x < 10 ? 1 : 0)}x`;
const leftText = (v) => (v >= 0 ? `${pct(v, 1)} left` : `overspent by ${pct(-v, 1)}`);
// Chart coordinates. Numbers only, escaped anyway so every value takes the same path.
const num = (x) => esc((+x).toFixed(2));

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// One rule colours a day in the strip and a recent burn rate: good while it spends
// budget no faster than the SLO allows (burn rate up to 1), bad past 10 times that.
const toneOf = (burn) => (burn === null ? 'none' : burn <= 1 ? 'good' : burn <= 10 ? 'warn' : 'bad');
const LEVEL = { good: 'met the SLO', warn: 'missed', bad: 'missed badly', none: 'no data' };

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
  if (stale.length) notes.push(`Stale, no recent probe: ${stale.join(', ')}.`);
  if (none.length && none.length < stats.length) notes.push(`Waiting for a first probe: ${none.join(', ')}.`);
  if (none.length === stats.length) return { tone: 'none', head: 'Waiting for first probes', notes };
  if (down.length) return { tone: 'bad', head: count(down, 'down'), notes };
  if (slow.length) return { tone: 'warn', head: count(slow, 'slow'), notes };
  if (stale.length) return { tone: 'none', head: count(stale, 'stale'), notes };
  return { tone: 'good', head: none.length ? 'All probed services operational' : 'All services operational', notes };
}

// Everything the tile and the panel show for one service, worked out once.
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
    avail: availability(w), lat: latency(w),
    left: w.total ? budgetRemaining(t.slo, perWindow, w.total - w.good) : null,
    series: burndown(cal.map(({ d }) => (d ? d.total - d.good : 0)), (1 - t.slo) * perWindow),
    p95: percentile(recent.filter((p) => p.ok).map((p) => p.ms), 95),
    burn24: burn(now - DAY_MS), burn1: burn(now - HOUR_MS),
  };
}

// Error budget as a figure, a sentence and a meter. left: 1 untouched, 0 spent, below 0 overspent.
function budget(t, left) {
  if (left === null) return { tone: 'none', value: 'No data', text: 'No probes in the window yet', bar: '' };
  const mins = budgetMinutes(t.slo);
  if (left < 0) {
    return { tone: 'bad', value: pct(left, 1), bar: '<span class="over"></span>',
      text: `Overspent by ${(-left * mins).toFixed(1)} min of a ${mins.toFixed(1)} min budget` };
  }
  return { tone: left > 0.25 ? 'good' : left > 0 ? 'warn' : 'bad', value: pct(left, 1),
    bar: `<span style="width:${num(left * 100)}%"></span>`,
    text: left > 0 ? `${(left * mins).toFixed(1)} of ${mins.toFixed(1)} min left` : `Spent, all ${mins.toFixed(1)} min` };
}

const note = (tone, text) => `<p class="s ${tone}">${icon(tone)}<span>${esc(text)}</span></p>`;
const kpi = (tone, label, value, extra) => `
      <div class="kpi ${tone}"><p class="k">${esc(label)}</p><p class="v">${esc(value)}</p>${extra}</div>`;

// Summary tile: state first, then the two numbers that say how bad.
function tile(v) {
  const figs = v.last
    ? `<span><b>${esc(v.avail === null ? 'No data' : pct(v.avail))}</b> availability</span>
      <span><b>${esc(budget(v.t, v.left).value)}</b> budget left</span>`
    : '<span>No probes yet</span>';
  return `
  <li><a class="tile ${v.tone}" href="#${esc(v.t.id)}">
    <span class="state">${icon(v.tone)}${v.label}</span>
    <span class="name">${esc(v.t.name)}</span>
    <span class="figs">${figs}</span>
  </a></li>`;
}

// Plots are drawn in a 100 x 100 box stretched to the container, so the same
// numbers place the HTML labels as percentages. Strokes keep their width
// (vector-effect in the CSS), and the labels are HTML so they never stretch.
function figure(title, caption, body) {
  return `
    <figure class="chart">
      <figcaption><h3>${title}</h3><p>${caption}</p></figcaption>${body}
    </figure>`;
}

function burndownChart(v) {
  const { t, cal, series } = v;
  const caption = 'Budget left after each day of the window. Dashed: spending exactly on pace (1.0x).';
  if (v.left === null) return figure('Error budget burndown', caption, '<p class="nodata">No probes in the window yet.</p>');
  const end = series[series.length - 1]; // the burndown only falls, so this is also the lowest point
  const lo = Math.min(0, end);
  const y = (val) => 14 + ((1 - val) / (1 - lo)) * 78; // room above 100% for its label, below 0 for air
  const pts = [[0, y(1)], ...series.map((val, i) => [((i + 1) / WINDOW_DAYS) * 100, y(val)])];
  const line = `M${pts.map(([a, b]) => `${num(a)} ${num(b)}`).join('L')}`;
  const z = y(0);
  const area = `${line}L100 ${num(z)}L0 ${num(z)}Z`;
  const yEnd = num(y(end));
  const spent = cal[series.findIndex((val) => val <= 0)]?.day;
  const id = `${esc(t.id)}-bd`;
  const hits = cal.map(({ day, d }, i) => `<rect class="hit" x="${num((i * 100) / WINDOW_DAYS)}" y="0" width="${num(100 / WINDOW_DAYS)}" height="100">`
    + `<title>${esc(`${day}: ${d ? `${d.total - d.good} failed of ${d.total} probes` : 'no data'}, budget ${leftText(series[i])}`)}</title></rect>`).join('');
  const over = end < 0 ? ' bad' : '';
  return figure('Error budget burndown', caption, `
      <div class="plot">
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
        <span class="lbl" style="top:${num(y(1))}%" aria-hidden="true">100%</span>
        <span class="lbl" style="top:${num(z)}%" aria-hidden="true">0%, budget spent</span>
        <span class="lbl end${over}${y(end) < 30 ? ' below' : ''}" style="top:${yEnd}%" aria-hidden="true">${esc(leftText(end))}</span>
      </div>
      <div class="ends" aria-hidden="true"><span>${esc(cal[0].day)}</span><span>Today</span></div>`);
}

function latencyChart(v, now) {
  const { t, recent } = v;
  const caption = `Time to response headers for each probe. Dashed: the ${esc(dur(t.threshold))} threshold. Red ticks: failed probes.`;
  if (!recent.length) return figure('Response time, last 24 h', caption, '<p class="nodata">No probes in the last 24 hours.</p>');
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
    const parts = [`${inHour.length} probe${inHour.length === 1 ? '' : 's'}`];
    if (ms.length) parts.push(`median ${dur(percentile(ms, 50))}`, `slowest ${dur(Math.max(...ms))}`);
    if (ms.length < inHour.length) parts.push(`${inHour.length - ms.length} failed`);
    const x0 = x(from);
    return `<rect class="hit" x="${num(x0)}" y="0" width="${num(x(from + HOUR_MS) - x0)}" height="100">`
      + `<title>${esc(`${new Date(from).toISOString().slice(11, 16)} UTC: ${parts.join(', ')}`)}</title></rect>`;
  }).join('');
  const slow = okMs.filter((ms) => ms > t.threshold).length;
  const failed = recent.length - good.length;
  const summary = okMs.length
    ? `${recent.length} probes. Of the ${okMs.length} that answered: median ${dur(percentile(okMs, 50))}, p95 ${dur(v.p95)}, slowest ${dur(Math.max(...okMs))}, ${slow} over the ${dur(t.threshold)} threshold. ${failed} failed.`
    : `${recent.length} probes, all failed.`;
  // Each line is written twice, clipped above and below the threshold. A <use> would
  // save the bytes, but Chrome then stretches its stroke despite non-scaling-stroke.
  return figure('Response time, last 24 h', caption, `
      <div class="plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-labelledby="${id}-t ${id}-d">
          <title id="${id}-t">Response time over the last 24 hours</title>
          <desc id="${id}-d">${esc(summary)}</desc>
          <defs>
            <clipPath id="${id}-hi"><rect x="-5" y="-5" width="110" height="${num(thr + 5)}"/></clipPath>
            <clipPath id="${id}-lo"><rect x="-5" y="${num(thr)}" width="110" height="${num(105 - thr)}"/></clipPath>
          </defs>
          <path class="axis" d="M0 100H100"/>
          <path class="thr" d="M0 ${num(thr)}H100"/>
          <path class="ln" d="${line}" clip-path="url(#${id}-lo)"/>
          <path class="ln warn" d="${line}" clip-path="url(#${id}-hi)"/>
          ${dots ? `<path class="ring" d="${dots}"/><path class="dot" d="${dots}" clip-path="url(#${id}-lo)"/><path class="dot warn" d="${dots}" clip-path="url(#${id}-hi)"/>` : ''}
          ${fails ? `<path class="fail" d="${fails}"/>` : ''}
          ${hits}
        </svg>
        <span class="lbl" style="top:${num(thr)}%" aria-hidden="true">${esc(dur(t.threshold))} threshold</span>
      </div>
      <div class="ends" aria-hidden="true"><span>24 h ago</span><span>Now</span></div>`);
}

// 30 daily bars, oldest first. The bars are hidden from screen readers;
// the sentence under them carries the same facts, and the table every number.
function history(v) {
  const { t, cal } = v;
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
    return `<span class="${tone}" title="${esc(`${day}: ${pct(a)} up, ${d.good} of ${d.total} probes, ${LEVEL[tone]}`)}"></span>`;
  }).join('');
  const parts = Object.keys(count).filter((k) => count[k])
    .map((k) => `<span class="key"><i class="sw ${k}" aria-hidden="true"></i>${esc(`${count[k]} ${LEVEL[k]}`)}</span>`);
  const low = worst ? ` Worst day ${worst.day} at ${pct(worst.a)}.` : '';
  return `
    <figure class="chart wide">
      <figcaption><h3>Daily availability, 30 days</h3><p>One bar per UTC day against the ${esc(target(t.slo))} SLO. Hover a bar for its numbers.</p></figcaption>
      <div aria-hidden="true">
        <div class="strip">${bars}</div>
        <div class="ends"><span>${esc(cal[0].day)}</span><span>Today</span></div>
      </div>
      <p class="daysum">Last 30 days: ${parts.join(', ')}.${esc(low)}</p>
    </figure>`;
}

// The table twin of the strip and the burndown, newest day first, collapsed.
function table(v) {
  const rows = v.cal.map(({ day, d }, i) => `<tr><td>${esc(day)}</td>${d
    ? `<td>${esc(d.total)}</td><td>${esc(d.total - d.good)}</td><td>${esc(pct(d.good / d.total))}</td>`
    : '<td colspan="3">No data</td>'}<td>${esc(pct(v.series[i], 1))}</td></tr>`).reverse().join('');
  return `
    <details class="raw"><summary>Daily numbers</summary>
      <div class="scroll"><table>
        <thead><tr><th scope="col">Day, UTC</th><th scope="col">Probes</th><th scope="col">Failed</th><th scope="col">Up</th><th scope="col">Budget left</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`;
}

const BURN = { good: 'Within the pace the SLO allows', warn: 'Faster than the SLO allows',
  bad: 'Over 10x the pace the SLO allows', none: 'Too few probes in the last 24 h' };

function panel(v, now) {
  const { t, last } = v;
  const head = `
  <header class="phead">
    <div><h2>${esc(t.name)}</h2><a class="host" href="${esc(t.url)}" rel="noopener noreferrer">${esc(new URL(t.url).host)}</a></div>
    <span class="pill ${v.tone}">${icon(v.tone)}${v.label}</span>
  </header>`;

  if (!last) {
    // Cloudflare crons fire on the clock, so the next run is the next multiple.
    // GitHub starts scheduled runs late by a varying amount, so no number for it.
    const every = DAY_MS / PER_DAY[t.cron];
    const wait = Math.max(1, Math.round((Math.ceil(now / every) * every - now) / 60_000));
    const next = t.source ? 'after the next GitHub Actions run' : `in about ${wait} min`;
    return `
<section class="panel" id="${esc(t.id)}">${head}
  <div class="empty">
    <p><b>No probes yet.</b> ${esc(t.name)} is checked ${esc(EVERY[t.cron] ?? t.cron)}, so the first result should arrive ${esc(next)}.</p>
    <p>It will be held to ${esc(target(t.slo))} availability, with ${esc(target(t.latencySlo))} of good probes answering within ${esc(dur(t.threshold))}.</p>
  </div>
</section>`;
  }

  const result = last.status === null ? esc(last.err) : `HTTP ${esc(last.status)} in ${esc(dur(last.ms))}`;
  const when = `<time datetime="${esc(new Date(last.ts).toISOString())}" title="${esc(stamp(last.ts))}">${esc(ago(now - last.ts))}</time>`;
  const stale = v.state === 'stale'
    ? `\n  <p class="last">Stale: no probe since then, though it should run ${esc(EVERY[t.cron] ?? t.cron)}. Its current state is unknown.</p>`
    : '';
  const verdict = (x, goal, what) => (x === null ? note('none', 'No data yet')
    : x >= goal ? note('good', `Meets the ${target(goal)} ${what}`) : note('bad', `Below the ${target(goal)} ${what}`));

  const b = budget(t, v.left);
  const b24 = toneOf(v.burn24);
  const hour = v.burn1 === null ? '<p class="s">Last 1 h: too few probes for a rate</p>' : note(toneOf(v.burn1), `Last 1 h: ${rate(v.burn1)}`);
  const newest = {
    up: [dur(last.ms), 'good', `Under the ${dur(t.threshold)} threshold`],
    slow: [dur(last.ms), 'warn', `Over the ${dur(t.threshold)} threshold`],
    down: ['Failed', 'bad', last.status === null ? 'No response' : `HTTP ${last.status}`],
    stale: [last.ok ? dur(last.ms) : 'Failed', 'none', `${ago(now - last.ts)}, current state unknown`],
  }[v.state];

  return `
<section class="panel${v.state === 'down' ? ' is-down' : ''}" id="${esc(t.id)}">${head}
  <p class="last${last.ok ? '' : ' bad'}">Last probe ${when}${last.ok ? '' : ' failed'}: ${result}</p>${stale}
  <div class="kpis">${kpi(v.avail === null ? 'none' : v.avail >= t.slo ? 'good' : 'bad', 'Availability, 30 days',
    v.avail === null ? 'No data' : pct(v.avail), verdict(v.avail, t.slo, 'SLO'))}${kpi(b.tone, 'Error budget left',
    b.value, `${note(b.tone, b.text)}<div class="bar" aria-hidden="true">${b.bar}</div>`)}${kpi(b24, 'Burn rate, last 24 h',
    v.burn24 === null ? 'No data' : rate(v.burn24), `${note(b24, BURN[b24])}${hour}<p class="s">1.0x = on pace to spend the budget in exactly 30 days</p>`)}${kpi(newest[1], 'Newest probe',
    newest[0], note(newest[1], newest[2]))}
  </div>
  <dl class="minor">
    <div><dt>p95, last 24 h</dt><dd><b>${esc(v.p95 === null ? 'No data' : dur(v.p95))}</b> good probes only</dd></div>
    <div><dt>Latency SLI, 30 days</dt><dd><b>${esc(v.lat === null ? 'No data' : pct(v.lat))}</b> under ${esc(dur(t.threshold))}${verdict(v.lat, t.latencySlo, 'target')}</dd></div>
    <div><dt>Probed</dt><dd>${esc(EVERY[t.cron] ?? t.cron)} from ${t.source ? 'GitHub Actions' : 'Cloudflare'}</dd></div>
    <div><dt>Window</dt><dd>${esc(WINDOW_DAYS)} UTC days, ${esc(v.cal.filter(({ d }) => d).length)} with data</dd></div>
  </dl>
  <div class="charts">${burndownChart(v)}${latencyChart(v, now)}
  </div>${history(v)}${v.left === null ? '' : table(v)}
</section>`;
}

// Favicon dot in the overall tone. Hex is spelled out: a data: URI cannot read CSS variables.
const DOT = { good: '2e8b57', warn: 'b8800f', bad: 'b3301f', none: '8a8273' };
const favicon = (tone) => "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E"
  + `%3Ccircle cx='8' cy='8' r='7' fill='%23${DOT[tone]}'/%3E%3C/svg%3E`;

function renderPage(stats, now) {
  const views = stats.map((s) => derive(s, now));
  const { tone, head, notes } = overall(views, now);
  // source is only ever 'github' for now.
  const probed = TARGETS.map((t) => `<li>${esc(new URL(t.url).host)}: ${esc(EVERY[t.cron] ?? t.cron)}`
    + ` from ${t.source ? 'GitHub Actions, not from Cloudflare' : 'Cloudflare'}, ${esc(dur(t.timeout))} timeout</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="60">
<title>${esc(head)} | Uptime and SLOs</title>
<link rel="icon" href="${favicon(tone)}">
<style>
  /* Paper and ink from theoith.ink, so this reads as part of the same site. */
  :root {
    --bg: #f2ead9; --card: #fffcf4; --text: #1c1a17; --muted: #5a5347; --line: #e2d8c3; --track: #ece3d0;
    --link: #2b6b78; --axis: #b5a88e;
    /* Warn is a step darker than the site's amber, so a warn mark clears 3:1 on a card. */
    --good: #2e8b57; --good-ink: #236b43; --warn: #b8800f; --warn-ink: #855600;
    --bad: #b3301f; --bad-ink: #9e2a1b; --none: #d8cdb6; --none-ink: #5a5347;
    /* Data lines are ink. The link teal sits too close to the status green to share a chart. */
    --series: var(--text);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #15130f; --card: #1f1c17; --text: #f2ead9; --muted: #b3a994; --line: #35302a; --track: #2e2a23;
      --link: #7cc0cd; --axis: #5a5347;
      --good: #4caf7d; --good-ink: #86d4a6; --warn: #d9a441; --warn-ink: #f0c46e;
      --bad: #e06a55; --bad-ink: #f39a88; --none: #3d382f; --none-ink: #b3a994;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); overflow-wrap: break-word;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1160px; margin: 0 auto; padding: 0 16px 40px; }
  p { margin: 0; }
  a { color: var(--link); text-underline-offset: 2px; }
  /* Teal, not red: red already means down on this page. */
  a:focus-visible, summary:focus-visible { outline: 3px solid var(--link); outline-offset: 2px; border-radius: 4px; }
  .top { padding: 20px 0 4px; font-size: .9rem; }
  .top a { font-weight: 600; text-decoration: none; }
  .top a:hover { text-decoration: underline; }
  h1 { font-size: 1.75rem; line-height: 1.2; letter-spacing: -.01em; margin: 12px 0 4px; }
  h2 { font-size: 1.3rem; line-height: 1.3; margin: 0; }
  h3 { font-size: .95rem; line-height: 1.3; margin: 0; }
  .sub, .host, .last, dt, .ends, .daysum, .meta, figcaption p, footer, .nodata { color: var(--muted); }
  .sub { margin-bottom: 16px; }

  /* One tone per state. --c is the swatch, --ci the text shade, --on the glyph inside an icon. */
  .good { --c: var(--good); --ci: var(--good-ink); --on: var(--card); }
  .warn { --c: var(--warn); --ci: var(--warn-ink); --on: #1c1a17; }
  .bad { --c: var(--bad); --ci: var(--bad-ink); --on: var(--card); }
  .none { --c: var(--none); --ci: var(--none-ink); --on: var(--card); }
  .icon { flex: none; width: 1em; height: 1em; }
  .icon .f { fill: var(--c); }
  .icon .g { fill: none; stroke: var(--on); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .icon .d { fill: none; stroke: var(--ci); stroke-width: 1.6; stroke-dasharray: 2.6 2.1; }

  /* 1. The whole page in words. */
  .banner { display: grid; gap: 4px; padding: 16px 20px; margin-bottom: 16px; border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--c) 45%, var(--line));
    background: color-mix(in srgb, var(--c) 12%, var(--card)); }
  .banner h2 { display: flex; align-items: center; gap: 10px; font-size: 1.45rem; }
  .meta { font-size: .85rem; }

  /* 2. Each service, scannable across one row. Only trouble gets a coloured edge. */
  .tiles { list-style: none; padding: 0; margin: 0 0 28px; display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
  .tile { display: grid; gap: 2px; height: 100%; padding: 12px 16px 14px; border-radius: 10px; color: inherit; text-decoration: none;
    background: var(--card); border: 1px solid var(--line); border-top: 4px solid var(--line); }
  .tile.warn, .tile.bad { border-top-color: var(--c); }
  .tile:hover { background: color-mix(in srgb, var(--text) 4%, var(--card)); }
  .tile .state { display: flex; align-items: center; gap: 6px; font-size: .85rem; font-weight: 650; color: var(--ci); }
  .tile .name { font-size: 1.1rem; font-weight: 650; }
  .tile .figs { display: flex; flex-wrap: wrap; gap: 0 16px; font-size: .85rem; color: var(--muted); }
  .tile .figs b { color: var(--text); font-size: 1rem; font-weight: 650; }

  /* 3. One panel per service: state, then SLO numbers, then charts, then raw numbers. */
  .panel { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px 24px 22px;
    margin-bottom: 20px; scroll-margin-top: 12px; }
  .panel.is-down { border-color: var(--bad); }
  .phead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .host { font-size: .9rem; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; white-space: nowrap;
    font-size: .85rem; font-weight: 650; color: var(--ci); background: color-mix(in srgb, var(--c) 16%, var(--card));
    border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); }
  .last { font-size: .9rem; margin-top: 8px; overflow-wrap: anywhere; }
  .last.bad { color: var(--ci); }

  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
  .kpi { display: grid; align-content: start; gap: 4px; min-width: 0; padding: 12px 14px 14px; border-radius: 10px;
    border: 1px solid var(--line); border-top: 3px solid var(--line); }
  .kpi.warn, .kpi.bad { border-top-color: var(--c); }
  .kpi .k { font-size: .8rem; color: var(--muted); }
  .kpi .v { font-size: 1.75rem; font-weight: 650; line-height: 1.15; letter-spacing: -.01em; }
  .s { display: flex; align-items: flex-start; gap: 6px; font-size: .8rem; line-height: 1.35; color: var(--muted); }
  .s .icon { margin-top: .15em; }
  .s.good, .s.warn, .s.bad { color: var(--ci); font-weight: 600; }
  .bar { height: 6px; margin-top: 4px; border-radius: 999px; background: var(--track); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--c); }
  /* Overspent: a full bar, striped, so it does not read as a full budget. */
  .bar .over { width: 100%; background: repeating-linear-gradient(135deg, var(--bad) 0 6px, transparent 6px 10px); }

  .minor { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px 24px; margin: 14px 0 0; padding: 0 2px; }
  dt { font-size: .75rem; }
  dd { margin: 0; font-size: .85rem; color: var(--muted); }
  dd b { color: var(--text); font-size: 1rem; font-weight: 650; margin-right: 4px; }
  dd .s { margin-top: 2px; }

  .charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 18px; }
  .chart { margin: 0; min-width: 0; padding: 14px 16px 12px; border: 1px solid var(--line); border-radius: 10px; }
  .chart.wide { margin-top: 16px; }
  figcaption p { font-size: .8rem; }
  .plot { position: relative; height: 160px; margin-top: 12px; }
  .plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .plot path { fill: none; vector-effect: non-scaling-stroke; }
  .grid { stroke: var(--line); stroke-width: 1; }
  .axis { stroke: var(--axis); stroke-width: 1; }
  /* Dashed only for the two reference lines, never for grid or axes. */
  .pace, .thr { stroke: var(--muted); stroke-width: 1.25; stroke-dasharray: 4 4; }
  .ln { stroke: var(--series); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .ln.warn, .dot.warn { stroke: var(--warn); }
  .ln.bad, .dot.bad, .fail { stroke: var(--bad); }
  .plot .wash { fill: var(--series); fill-opacity: .07; }
  .plot .wash.bad { fill: var(--bad); fill-opacity: .16; }
  .ring { stroke: var(--card); stroke-width: 12; stroke-linecap: round; }
  .dot { stroke: var(--series); stroke-width: 8; stroke-linecap: round; }
  .fail { stroke-width: 2; }
  .hit { fill: transparent; }
  .hit:hover { fill: color-mix(in srgb, var(--text) 8%, transparent); }
  .lbl { position: absolute; left: 0; transform: translateY(-100%); padding: 0 4px 2px 0; font-size: .75rem; line-height: 1.2;
    color: var(--muted); white-space: nowrap; background: color-mix(in srgb, var(--card) 85%, transparent); pointer-events: none; }
  .lbl.end { left: auto; right: 0; padding: 0 0 2px 4px; transform: translateY(calc(-100% - 8px)); color: var(--text); font-weight: 650; }
  .lbl.end.below { transform: translateY(8px); }
  .lbl.end.bad { color: var(--bad-ink); }
  .nodata { font-size: .9rem; padding: 40px 0; text-align: center; }

  .strip { display: grid; grid-template-columns: repeat(${WINDOW_DAYS}, 1fr); gap: 3px; height: 34px; margin-top: 12px; }
  .strip span { border-radius: 2px; background: var(--c); }
  .strip span:hover { opacity: .7; }
  /* No data is hollow and dashed, like the no-data icon, so it is not a colour to learn. */
  .strip span.none, .sw.none { background: transparent; border: 1.5px dashed color-mix(in srgb, var(--muted) 60%, transparent); }
  .ends { display: flex; justify-content: space-between; font-size: .75rem; margin-top: 4px; }
  .daysum { font-size: .85rem; margin-top: 8px; }
  .key { white-space: nowrap; }
  .sw { display: inline-block; width: 9px; height: 13px; margin-right: 5px; border-radius: 2px; vertical-align: -1px; background: var(--c); }

  .raw { margin-top: 14px; font-size: .85rem; }
  summary { cursor: pointer; color: var(--link); font-weight: 600; }
  .scroll { overflow-x: auto; margin-top: 8px; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 4px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; padding-left: 0; }
  th { font-weight: 600; font-size: .78rem; color: var(--muted); }

  .empty { display: grid; gap: 6px; margin-top: 14px; padding: 14px 16px; border-radius: 8px; font-size: .9rem;
    color: var(--muted); border: 1px dashed color-mix(in srgb, var(--muted) 45%, transparent); }
  .empty b { color: var(--text); }

  /* 4. How it is measured, collapsed at the bottom. */
  footer { display: grid; gap: 10px; font-size: .85rem; border-top: 1px solid var(--line); margin-top: 24px; padding-top: 16px; }
  footer details > div { display: grid; gap: 8px; margin-top: 10px; }
  footer ul { margin: 0; padding-left: 20px; }

  @media (max-width: 760px) {
    .kpis, .minor { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .charts { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 480px) {
    h1 { font-size: 1.5rem; }
    .banner h2 { font-size: 1.25rem; }
    .panel { padding: 16px; }
    .kpi { padding: 10px 12px 12px; }
    .kpi .v { font-size: 1.4rem; }
    .chart { padding: 12px; }
    .strip { gap: 2px; height: 28px; }
  }
</style>
</head>
<body>
<div class="wrap">
<header class="top"><a href="https://theoith.ink/">&larr; theoith.ink</a></header>
<main>
  <h1>Uptime and SLOs</h1>
  <p class="sub">Availability and latency against written SLOs, over a rolling 30-day window in UTC days.</p>
  <section class="banner ${tone}" aria-labelledby="overall">
    <h2 id="overall">${icon(tone)}${esc(head)}</h2>
    ${notes.length ? `<p>${esc(notes.join(' '))}</p>` : ''}
    <p class="meta">Page built <time datetime="${esc(new Date(now).toISOString())}">${esc(stamp(now))}</time>. It reloads itself every minute.</p>
  </section>
  <ul class="tiles" aria-label="Services at a glance">${views.map(tile).join('')}
  </ul>
  ${views.map((v) => panel(v, now)).join('')}
</main>
<footer>
  <p>The two Cloudflare-hosted sites are probed from Cloudflare, so this page shares fate with them:
    a Cloudflare outage can take those sites, this page and the alerts down together.</p>
  ${PAUSED.map((t) => `<p>Paused: ${esc(t.name)} (${esc(new URL(t.url).host)}). ${esc(t.why)}</p>`).join('')}
  <details>
    <summary>How this is measured</summary>
    <div>
      <p>What is probed, and how often. A probe is up when the site answers 2xx within the timeout.
        The badge on each service is its newest probe. Slow means it answered, but slower than the latency threshold.
        Stale means no probe has arrived for ${esc(STALE_AFTER)} of its intervals, so its current state is unknown.</p>
      <ul>${probed}</ul>
      <p>The error budget is the number of probes allowed to fail in a full 30-day window, (1 &minus; SLO) &times; the window's probes,
        so a failure on day one costs what it would on day 30. The burndown starts the window at 100% and drops with each failed probe.
        Burn rate is the error rate over a recent window divided by the rate the SLO allows: 1.0x would spend the budget in exactly 30 days.</p>
      <p>The two Cloudflare-hosted sites are probed by a Cloudflare Cron Trigger, from whichever Cloudflare data center
        picks up the job. That means this monitor shares fate with them: if Cloudflare has an outage,
        those sites and this page can go down together, and no alert goes out.</p>
      <p>Hulog is probed by a scheduled GitHub Actions job, which sends each result here. The bot check in front of
        onrender.com blocks requests from Cloudflare Workers, so a probe from Cloudflare would measure that block, not Hulog.
        GitHub can start a scheduled run late or skip it, and a skipped run is missing data, not a failure.</p>
    </div>
  </details>
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
    const { pathname } = new URL(request.url);
    if (pathname === '/ingest') {
      if (request.method !== 'POST') return text('Method not allowed\n', 405, { allow: 'POST' });
      return ingest(request, env);
    }
    if (pathname !== '/') return text('Not found\n', 404);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text('Method not allowed\n', 405, { allow: 'GET, HEAD' });
    }
    const now = Date.now();
    const html = renderPage(await loadStats(env, now), now);
    return new Response(html, { headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8' } });
  },
};
