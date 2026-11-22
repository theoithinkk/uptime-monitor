import {
  FAILS_BEFORE_ALERT, sum, availability, latency,
  budgetRemaining, budgetMinutes, percentile, alertFor,
} from './slo.js';

// What gets probed. Hardcoded on purpose: no request can make this Worker
// fetch a URL of its choosing, so it cannot be used as an open proxy.
const TARGETS = [
  { id: 'portfolio', name: 'Portfolio', url: 'https://theoith.ink/',
    cron: '*/5 * * * *', timeout: 10_000, threshold: 1000, slo: 0.999, latencySlo: 0.99 },
  { id: 'writeups', name: 'CTF writeups', url: 'https://writeups.theoith.ink/',
    cron: '*/5 * * * *', timeout: 10_000, threshold: 1000, slo: 0.999, latencySlo: 0.99 },
];
// Not probed and not shown as a card; the page footer says why. Settings are
// kept so a target can move back into TARGETS unchanged.
const PAUSED = [
  // Render's free tier sleeps after 15 idle minutes. Probing hourly lets it
  // sleep, so this measures the cold start a real visitor gets.
  // Paused 2026-11-22: Cloudflare's bot check in front of onrender.com answers
  // requests from Workers with 429 and cf-mitigated: challenge.
  { id: 'hulog', name: 'Hulog', url: 'https://hulog.onrender.com/',
    cron: '0 * * * *', timeout: 90_000, threshold: 60_000, slo: 0.99, latencySlo: 0.95,
    why: 'The bot check in front of onrender.com blocks requests sent from Cloudflare Workers (HTTP 429), '
      + 'so a probe from here would measure that block, not Hulog. It comes back once it is probed from outside Cloudflare.' },
];
// Must match the crons in wrangler.toml.
const EVERY = { '*/5 * * * *': 'every 5 minutes', '0 * * * *': 'every hour' };
// Probes per day for each cron. The error budget is counted against a full
// window of probes, so a failure on day one costs what it would on day 30.
const PER_DAY = { '*/5 * * * *': 288, '0 * * * *': 24 };

const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
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

async function record(env, t, r) {
  const ok = r.ok ? 1 : 0;
  const fast = r.ok && r.ms <= t.threshold ? 1 : 0;
  // A batch runs as one transaction, so the raw row and the rollup never disagree.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO probes (target, ts, ok, status, ms, err) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(t.id, r.ts, ok, r.status, r.ms, r.err),
    env.DB.prepare(`INSERT INTO daily (target, day, total, good, fast) VALUES (?1, ?2, 1, ?3, ?4)
      ON CONFLICT(target, day) DO UPDATE SET
        total = total + 1, good = good + excluded.good, fast = fast + excluded.fast`)
      .bind(t.id, dayOf(r.ts), ok, fast),
  ]);
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

// Reads about 700 rows per view: per target, 30 daily rows,
// about 288 raw rows for the 24 h p95, and the newest probe.
async function loadStats(env, now) {
  const since = dayOf(now - (WINDOW_DAYS - 1) * DAY_MS);
  const res = await env.DB.batch(TARGETS.flatMap((t) => [
    env.DB.prepare('SELECT ts, ok, status, ms, err FROM probes WHERE target = ?1 ORDER BY ts DESC LIMIT 1')
      .bind(t.id),
    env.DB.prepare('SELECT day, total, good, fast FROM daily WHERE target = ?1 AND day >= ?2')
      .bind(t.id, since),
    env.DB.prepare('SELECT ms FROM probes WHERE target = ?1 AND ts >= ?2 AND ok = 1')
      .bind(t.id, now - DAY_MS),
  ]));
  return TARGETS.map((t, i) => {
    const [last, days, recent] = res.slice(i * 3, i * 3 + 3).map((r) => r.results);
    return { t, last: last[0] ?? null, days, p95: percentile(recent.map((r) => r.ms), 95) };
  });
}

// Every value that reaches the HTML goes through this, database values included.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (x, digits = 2) => `${(x * 100).toFixed(digits)}%`;
const target = (x) => `${+(x * 100).toFixed(2)}%`; // 0.999 -> 99.9%
const dur = (ms) => (ms < 10_000 ? `${ms} ms` : `${+(ms / 1000).toFixed(1)} s`);
const stamp = (ts) => `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// Strip colour: met the SLO, missed it, or missed it by more than 10x the budget.
const level = (a, slo) => (a >= slo ? 'good' : a >= 1 - 10 * (1 - slo) ? 'warn' : 'bad');
const LEVEL = { good: 'met the SLO', warn: 'missed', bad: 'missed badly', none: 'no data' };

// The badge is the newest probe only. Slow: it answered, but over the latency threshold.
const STATE = { up: ['good', 'Up'], slow: ['warn', 'Slow'], down: ['bad', 'Down'], none: ['none', 'Waiting'] };
function stateOf({ t, last }) {
  if (!last) return 'none';
  if (!last.ok) return 'down';
  return last.ms > t.threshold ? 'slow' : 'up';
}

// One headline for the whole page, worst news first.
function overall(stats) {
  const named = (s) => stats.filter((x) => stateOf(x) === s).map((x) => x.t.name);
  const [down, slow, none] = [named('down'), named('slow'), named('none')];
  const count = (list, word) => `${list.length} service${list.length === 1 ? '' : 's'} ${word}`;
  const notes = [];
  if (down.length) notes.push(`Down: ${down.join(', ')}.`);
  if (slow.length) notes.push(`Slow: ${slow.join(', ')}.`);
  if (none.length && none.length < stats.length) notes.push(`Waiting for a first probe: ${none.join(', ')}.`);
  if (none.length === stats.length) return { tone: 'none', head: 'Waiting for first probes', notes };
  if (down.length) return { tone: 'bad', head: count(down, 'down'), notes };
  if (slow.length) return { tone: 'warn', head: count(slow, 'slow'), notes };
  return { tone: 'good', head: none.length ? 'All probed services operational' : 'All services operational', notes };
}

// Error budget as text plus a bar. left: 1 untouched, 0 spent, below 0 overspent.
function budget(t, left) {
  if (left === null) return { tone: 'none', text: '<b>No data</b>', bar: '' };
  const mins = budgetMinutes(t.slo);
  if (left < 0) {
    return { tone: 'bad', bar: '<span class="over"></span>',
      text: `<b>Overspent by ${esc(pct(-left, 1))}</b> ${esc((-left * mins).toFixed(1))} min over a ${esc(mins.toFixed(1))} min budget` };
  }
  return { tone: left > 0.25 ? 'good' : left > 0 ? 'warn' : 'bad',
    bar: `<span style="width:${esc((left * 100).toFixed(1))}%"></span>`,
    text: `<b>${left > 0 ? `${esc(pct(left, 1))} left` : 'Spent'}</b> ${esc((left * mins).toFixed(1))} of ${esc(mins.toFixed(1))} min` };
}

// 30 daily bars, oldest first. The bars are hidden from screen readers;
// the sentence under them carries the same facts as text.
function strip(t, days, now) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const count = { good: 0, warn: 0, bad: 0, none: 0 };
  let worst = null;
  const first = dayOf(now - (WINDOW_DAYS - 1) * DAY_MS);
  const bars = Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const day = dayOf(now - (WINDOW_DAYS - 1 - i) * DAY_MS);
    const d = byDay.get(day);
    if (!d) {
      count.none++;
      return `<span class="none" title="${esc(day)}: no data"></span>`;
    }
    const a = d.good / d.total;
    const cls = level(a, t.slo);
    count[cls]++;
    if (cls !== 'good' && (!worst || a < worst.a)) worst = { day, a };
    return `<span class="${cls}" title="${esc(`${day}: ${pct(a)} up, ${d.good} of ${d.total} probes, ${LEVEL[cls]}`)}"></span>`;
  }).join('');
  const parts = Object.keys(count).filter((k) => count[k]).map((k) => `${count[k]} ${LEVEL[k]}`);
  const low = worst ? ` Worst day ${worst.day} at ${pct(worst.a)}.` : '';
  return `
  <div class="days">
    <div aria-hidden="true">
      <div class="strip">${bars}</div>
      <div class="ends"><span>${esc(first)}</span><span>Today</span></div>
    </div>
    <p class="daysum">Last 30 days: ${esc(parts.join(', '))}.${esc(low)}</p>
  </div>`;
}

function card(s, now) {
  const { t, last, days, p95 } = s;
  const [tone, label] = STATE[stateOf(s)];
  const head = `
  <div class="head">
    <div><h2>${esc(t.name)}</h2><a class="host" href="${esc(t.url)}" rel="noopener noreferrer">${esc(new URL(t.url).host)}</a></div>
    <span class="pill ${tone}">${label}</span>
  </div>`;

  if (!last) {
    // Crons fire on the clock (every 5 min, on the hour), so the next run is the next multiple.
    const every = DAY_MS / PER_DAY[t.cron];
    const wait = Math.max(1, Math.round((Math.ceil(now / every) * every - now) / 60_000));
    return `
<section class="card">${head}
  <div class="empty">
    <p><b>No probes yet.</b> ${esc(t.name)} is checked ${esc(EVERY[t.cron] ?? t.cron)}, so the first result should arrive in about ${esc(wait)} min.</p>
    <p>It will be held to ${esc(target(t.slo))} availability, with ${esc(target(t.latencySlo))} of good probes answering within ${esc(dur(t.threshold))}.</p>
  </div>
</section>`;
  }

  const w = sum(days);
  const avail = availability(w);
  const lat = latency(w);
  const left = w.total ? budgetRemaining(t.slo, WINDOW_DAYS * PER_DAY[t.cron], w.total - w.good) : null;
  const b = budget(t, left);
  const verdict = (x, goal, what) => (x === null ? '' : x >= goal
    ? `<span class="verdict good">Meets ${esc(target(goal))} ${what}</span>`
    : `<span class="verdict bad">Below ${esc(target(goal))} ${what}</span>`);
  const result = last.status === null ? esc(last.err) : `HTTP ${esc(last.status)} in ${esc(dur(last.ms))}`;
  const when = `<time datetime="${esc(new Date(last.ts).toISOString())}" title="${esc(stamp(last.ts))}">${esc(ago(now - last.ts))}</time>`;

  return `
<section class="card${last.ok ? '' : ' is-down'}">${head}
  <p class="last${last.ok ? '' : ' bad'}">Last probe ${when}${last.ok ? '' : ' failed'}: ${result}</p>
  <div class="hero">
    <p><span class="num">${avail === null ? 'No data' : esc(pct(avail))}</span> <span class="cap">availability, 30 days</span></p>
    ${verdict(avail, t.slo, 'SLO')}
  </div>
  <div class="budget ${b.tone}">
    <p class="row"><span class="cap">Error budget</span><span>${b.text}</span></p>
    <div class="bar" aria-hidden="true">${b.bar}</div>
  </div>
  <dl class="minor">
    <div><dt>Latency, 30 days</dt>
      <dd><b>${lat === null ? 'No data' : esc(pct(lat))}</b> under ${esc(dur(t.threshold))} ${verdict(lat, t.latencySlo, 'target')}</dd></div>
    <div><dt>p95, last 24 h</dt>
      <dd><b>${p95 === null ? 'No data' : esc(dur(p95))}</b> good probes only</dd></div>
  </dl>${strip(t, days, now)}
</section>`;
}

// Favicon dot in the overall tone. Hex is spelled out: a data: URI cannot read CSS variables.
const DOT = { good: '2e8b57', warn: 'c98a12', bad: 'b3301f', none: '8a8273' };
const favicon = (tone) => "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E"
  + `%3Ccircle cx='8' cy='8' r='7' fill='%23${DOT[tone]}'/%3E%3C/svg%3E`;

function renderPage(stats, now) {
  const { tone, head, notes } = overall(stats);
  const probed = TARGETS.map((t) =>
    `<li>${esc(new URL(t.url).host)}: ${esc(EVERY[t.cron] ?? t.cron)}, ${esc(dur(t.timeout))} timeout</li>`).join('');
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
    --link: #2b6b78;
    --good: #2e8b57; --good-ink: #236b43; --warn: #c98a12; --warn-ink: #855600;
    --bad: #b3301f; --bad-ink: #9e2a1b; --none: #d8cdb6; --none-ink: #5a5347;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #15130f; --card: #1f1c17; --text: #f2ead9; --muted: #b3a994; --line: #35302a; --track: #2e2a23;
      --link: #7cc0cd;
      --good: #4caf7d; --good-ink: #86d4a6; --warn: #d9a441; --warn-ink: #f0c46e;
      --bad: #e06a55; --bad-ink: #f39a88; --none: #3d382f; --none-ink: #b3a994;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); overflow-wrap: break-word;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 16px 40px; }
  p { margin: 0; }
  a { color: var(--link); text-underline-offset: 2px; }
  /* Teal, not red: red already means down on this page. */
  a:focus-visible { outline: 3px solid var(--link); outline-offset: 2px; border-radius: 3px; }
  .top { padding: 20px 0 4px; font-size: .9rem; }
  .top a { font-weight: 600; text-decoration: none; }
  .top a:hover { text-decoration: underline; }
  h1 { font-size: 1.75rem; line-height: 1.2; letter-spacing: -.01em; margin: 12px 0 4px; }
  h2 { font-size: 1.15rem; line-height: 1.3; margin: 0; }
  .sub, .host, .last, .cap, dt, .ends, .daysum, .legend, .meta, footer { color: var(--muted); }
  .sub { margin-bottom: 20px; }

  /* One tone per state. Each element picks the swatch (--c) or the text shade (--ci). */
  .good { --c: var(--good); --ci: var(--good-ink); }
  .warn { --c: var(--warn); --ci: var(--warn-ink); }
  .bad { --c: var(--bad); --ci: var(--bad-ink); }
  .none { --c: var(--none); --ci: var(--none-ink); }
  .dot { display: inline-block; flex: none; width: 12px; height: 12px; border-radius: 50%; background: var(--c); }

  .banner { display: grid; gap: 4px; padding: 16px 18px; margin-bottom: 16px; border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--c) 45%, var(--line));
    background: color-mix(in srgb, var(--c) 12%, var(--card)); }
  .banner h2 { display: flex; align-items: center; gap: 10px; font-size: 1.25rem; }
  .meta { font-size: .85rem; }

  .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; list-style: none; padding: 0; margin: 0 0 12px; font-size: .8rem; }
  .legend li { display: flex; align-items: center; gap: 6px; }
  .legend .dot { width: 8px; height: 14px; border-radius: 2px; }

  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 20px 22px; margin-bottom: 14px; }
  .card.is-down { border-color: var(--bad); }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .host { font-size: .9rem; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; white-space: nowrap;
    font-size: .8rem; font-weight: 650; color: var(--ci); background: color-mix(in srgb, var(--c) 16%, var(--card));
    border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); }
  .pill::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
  .last { font-size: .9rem; margin-top: 8px; overflow-wrap: anywhere; }
  .last.bad { color: var(--ci); }

  .hero { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 4px 16px; margin: 16px 0; }
  .num { display: block; font-size: 2.5rem; font-weight: 700; line-height: 1.1; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .cap { font-size: .85rem; }
  .verdict { color: var(--ci); font-weight: 600; font-size: .9rem; }

  .budget .row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; font-size: .9rem; margin-bottom: 6px; }
  .budget b { color: var(--ci); font-variant-numeric: tabular-nums; }
  .bar { height: 8px; border-radius: 999px; background: var(--track); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--c); }
  /* Overspent: a full bar, striped, so it does not read as a full budget. */
  .bar .over { width: 100%; background: repeating-linear-gradient(135deg, var(--bad) 0 6px, transparent 6px 10px); }

  .minor { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px 24px;
    margin: 16px 0; padding-top: 14px; border-top: 1px solid var(--line); }
  dt { font-size: .8rem; }
  dd { margin: 0; }
  dd b { font-size: 1.1rem; margin-right: 4px; font-variant-numeric: tabular-nums; }
  dd .verdict { display: block; font-size: .85rem; }

  .strip { display: grid; grid-template-columns: repeat(${WINDOW_DAYS}, 1fr); gap: 3px; height: 34px; }
  .strip span { border-radius: 2px; background: var(--c); }
  .strip span:hover { opacity: .7; }
  .ends { display: flex; justify-content: space-between; font-size: .75rem; margin-top: 4px; }
  .daysum { font-size: .85rem; margin-top: 6px; }

  .empty { display: grid; gap: 6px; margin-top: 14px; padding: 14px 16px; border-radius: 8px; font-size: .9rem;
    color: var(--muted); border: 1px dashed color-mix(in srgb, var(--muted) 45%, transparent); }
  .empty b { color: var(--text); }

  footer { display: grid; gap: 8px; font-size: .85rem; border-top: 1px solid var(--line); margin-top: 24px; padding-top: 16px; }
  footer ul { margin: 0; padding-left: 20px; }

  @media (max-width: 480px) {
    h1 { font-size: 1.5rem; }
    .card { padding: 16px; }
    .num { font-size: 2.1rem; }
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
    <h2 id="overall"><span class="dot"></span>${esc(head)}</h2>
    ${notes.length ? `<p>${esc(notes.join(' '))}</p>` : ''}
    <p class="meta">Page built <time datetime="${esc(new Date(now).toISOString())}">${esc(stamp(now))}</time>. It reloads itself every minute.</p>
  </section>
  <ul class="legend" aria-label="Colours in the daily bars">
    <li><span class="dot good"></span>Met the SLO</li>
    <li><span class="dot warn"></span>Missed</li>
    <li><span class="dot bad"></span>Missed badly, over 10x the allowed failures</li>
    <li><span class="dot none"></span>No data</li>
  </ul>
  ${stats.map((s) => card(s, now)).join('')}
</main>
<footer>
  <p>What is probed, and how often. A probe is up when the site answers 2xx within the timeout.
    The badge on each service is its newest probe. Slow means it answered, but slower than the latency threshold.</p>
  <ul>${probed}</ul>
  ${PAUSED.map((t) => `<p>Paused: ${esc(t.name)} (${esc(new URL(t.url).host)}). ${esc(t.why)}</p>`).join('')}
  <p>Probes run on a Cloudflare Cron Trigger, from whichever Cloudflare data center picks up the job.
    That means this monitor shares fate with the two Cloudflare-hosted sites: if Cloudflare has an outage,
    those sites and this page can go down together, and no alert goes out.</p>
</footer>
</div>
</body>
</html>`;
}

function text(body, status, extra = {}) {
  return new Response(body, { status, headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8', ...extra } });
}

export default {
  async scheduled(controller, env) {
    const due = TARGETS.filter((t) => t.cron === controller.cron);
    if (due.length === 0) console.warn(`no targets for cron "${controller.cron}"`);
    // allSettled, so one target failing never stops another being recorded.
    const results = await Promise.allSettled(due.map(async (t) => {
      const r = await probe(t);
      await record(env, t, r);
      console.log(`${t.id}: ${r.ok ? 'up' : 'down'}, ${r.status ?? r.err}, ${r.ms} ms`);
      await alertIfChanged(env, t, r);
    }));
    const failed = results.filter((x) => x.status === 'rejected').map((x) => x.reason);
    if (failed.length) throw new AggregateError(failed, 'could not record probe results');
  },

  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/') return text('Not found\n', 404);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text('Method not allowed\n', 405, { allow: 'GET, HEAD' });
    }
    const now = Date.now();
    const html = renderPage(await loadStats(env, now), now);
    return new Response(html, { headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8' } });
  },
};
