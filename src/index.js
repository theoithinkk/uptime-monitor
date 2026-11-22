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
  // Render's free tier sleeps after 15 idle minutes. Probing hourly lets it
  // sleep, so this measures the cold start a real visitor gets.
  { id: 'hulog', name: 'Hulog', url: 'https://hulog.onrender.com/',
    cron: '0 * * * *', timeout: 90_000, threshold: 60_000, slo: 0.99, latencySlo: 0.95 },
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
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// Strip colour: met the SLO, missed it, or missed it by more than 10x the budget.
const level = (a, slo) => (a >= slo ? 'good' : a >= 1 - 10 * (1 - slo) ? 'warn' : 'bad');

function card({ t, last, days, p95 }, now) {
  const w = sum(days);
  const avail = availability(w);
  const lat = latency(w);
  const left = w.total ? budgetRemaining(t.slo, WINDOW_DAYS * PER_DAY[t.cron], w.total - w.good) : null;

  let badge = '<span class="badge none">No data</span>';
  let lastLine = 'No probes yet.';
  if (last) {
    badge = last.ok ? '<span class="badge up">Up</span>' : '<span class="badge down">Down</span>';
    const what = last.status === null ? esc(last.err) : `HTTP ${esc(last.status)} in ${esc(dur(last.ms))}`;
    lastLine = `Last probe ${esc(ago(now - last.ts))}: ${what}`;
  }

  const verdict = (x, goal) => (x === null ? '' : x >= goal
    ? `<span class="met">meets ${esc(target(goal))}</span>`
    : `<span class="miss">below ${esc(target(goal))}</span>`);

  const byDay = new Map(days.map((d) => [d.day, d]));
  const cells = Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const day = dayOf(now - (WINDOW_DAYS - 1 - i) * DAY_MS);
    const d = byDay.get(day);
    const label = d ? `${day}: ${pct(d.good / d.total)} of ${d.total} probes up` : `${day}: no data`;
    const cls = d ? level(d.good / d.total, t.slo) : 'none';
    return `<li class="${cls}" title="${esc(label)}"><span class="sr">${esc(label)}</span></li>`;
  }).join('');

  return `
<section class="card">
  <div class="head"><h2>${esc(t.name)}</h2>${badge}</div>
  <p class="url"><a href="${esc(t.url)}" rel="noopener noreferrer">${esc(new URL(t.url).host)}</a></p>
  <p class="last">${lastLine}</p>
  <dl>
    <div><dt>Availability, 30 days</dt>
      <dd><b>${avail === null ? 'No data' : esc(pct(avail))}</b> ${verdict(avail, t.slo)}</dd></div>
    <div><dt>Error budget left</dt>
      <dd>${left === null ? '<b>No data</b>' : `<b${left > 0 ? '' : ' class="miss"'}>${esc(pct(left, 1))}</b>
        ${esc(Math.max(0, left * budgetMinutes(t.slo)).toFixed(1))} of ${esc(budgetMinutes(t.slo).toFixed(1))} min left`}</dd></div>
    <div><dt>Latency, 30 days</dt>
      <dd><b>${lat === null ? 'No data' : esc(pct(lat))}</b> under ${esc(dur(t.threshold))} ${verdict(lat, t.latencySlo)}</dd></div>
    <div><dt>p95, last 24 h</dt>
      <dd><b>${p95 === null ? 'No data' : esc(dur(p95))}</b> good probes only</dd></div>
  </dl>
  <ol class="strip" aria-label="Daily availability for the last 30 days, oldest first">${cells}</ol>
  <div class="ends"><span>30 days ago</span><span>today</span></div>
</section>`;
}

function renderPage(stats, now) {
  const probed = TARGETS.map((t) =>
    `<li>${esc(new URL(t.url).host)}: ${esc(EVERY[t.cron] ?? t.cron)}, ${esc(dur(t.timeout))} timeout</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Uptime and SLOs</title>
<style>
  :root {
    --bg: #f5f6f8; --card: #ffffff; --text: #1a1e23; --muted: #5a6472; --line: #e2e5e9;
    --good: #1e9e57; --warn: #d39a1f; --bad: #d64545; --none: #d6dae0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1216; --card: #171b21; --text: #e5e8ec; --muted: #9aa3af; --line: #272d35;
      --good: #34b36f; --warn: #e0a83a; --bad: #e35d5d; --none: #2d343d;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  h2 { font-size: 1.15rem; margin: 0; }
  .sub, .url, .last, .ends, footer { color: var(--muted); }
  .sub { margin: 0 0 24px; }
  a { color: inherit; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 18px 20px; margin-bottom: 16px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .url, .last { margin: 2px 0; font-size: 0.9rem; }
  .badge { font-size: 0.8rem; font-weight: 600; padding: 2px 10px; border-radius: 999px; color: #fff; }
  .badge.up { background: var(--good); }
  .badge.down { background: var(--bad); }
  .badge.none { background: var(--none); color: var(--text); }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px 20px; margin: 16px 0; }
  dt { font-size: 0.8rem; color: var(--muted); }
  dd { margin: 0; }
  dd b { font-size: 1.15rem; margin-right: 4px; }
  .met { color: var(--good); font-weight: 600; }
  .miss { color: var(--bad); font-weight: 600; }
  .strip { display: grid; grid-template-columns: repeat(${WINDOW_DAYS}, 1fr); gap: 3px;
    list-style: none; margin: 0; padding: 0; }
  .strip li { height: 28px; border-radius: 3px; background: var(--none); }
  .strip li.good { background: var(--good); }
  .strip li.warn { background: var(--warn); }
  .strip li.bad { background: var(--bad); }
  .ends { display: flex; justify-content: space-between; font-size: 0.75rem; margin-top: 4px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  footer { font-size: 0.85rem; border-top: 1px solid var(--line); margin-top: 24px; padding-top: 16px; }
  footer ul { margin: 4px 0 12px; padding-left: 20px; }
</style>
</head>
<body>
<main>
  <h1>Uptime and SLOs</h1>
  <p class="sub">Rolling 30-day window, in UTC days. Strip colours: green met the SLO that day,
    amber missed it, red missed it badly, grey has no data.</p>
  ${stats.map((s) => card(s, now)).join('')}
  <footer>
    <p>What is probed, and how often. A probe is up when the site answers 2xx within the timeout.</p>
    <ul>${probed}</ul>
    <p>Probes run on a Cloudflare Cron Trigger, from whichever Cloudflare data center picks up the job.
      That means this monitor shares fate with the two Cloudflare-hosted sites: if Cloudflare has an outage,
      those sites and this page can go down together, and no alert goes out.</p>
    <p>Page built ${esc(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>
  </footer>
</main>
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
