import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// Stands in for the D1 binding: answers the three reads loadStats makes per target.
function fakeDB(data) {
  return {
    prepare: (sql) => ({ bind: (...args) => ({ sql, args }) }),
    batch: async (stmts) => stmts.map(({ sql, args: [id] }) => {
      const d = data[id] ?? { probes: [], days: [] };
      if (sql.includes('LIMIT 1')) return { results: d.probes.slice(0, 1) };
      if (sql.includes('FROM daily')) return { results: d.days };
      // The last 24 h, failed probes included, oldest first.
      return { results: d.probes.map(({ ts, ok, ms }) => ({ ts, ok, ms })).sort((a, b) => a.ts - b.ts) };
    }),
  };
}

async function page(data, path = '/') {
  const res = await worker.fetch(new Request(`http://localhost${path}`), { DB: fakeDB(data) });
  return { res, html: await res.text() };
}

test('status page escapes database text and ships no script', async () => {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const { res, html } = await page({
    portfolio: {
      probes: [{ ts: now - 60_000, ok: 0, status: null, ms: 10_000, err: '<script>alert(1)</script>' }],
      days: [{ day: today, total: 10, good: 0, fast: 0 }],
    },
    writeups: { probes: [{ ts: now - 60_000, ok: 1, status: 200, ms: 120, err: null }], days: [] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'),
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/);
  assert.match(html, /1 service down/);
  assert.match(html, /Overspent by/);
  // Hulog is back as a card, and the footer says where its probe runs.
  assert.match(html, /<h2>Hulog<\/h2>/);
  assert.match(html, /hulog\.onrender\.com: every hour from GitHub Actions, started by this monitor, with GitHub&rsquo;s own schedule as a backup, 90 s timeout/);
  assert.doesNotMatch(html, /Paused:/);
});

test('status page with no probes at all says it is waiting', async () => {
  const { html } = await page({});
  assert.match(html, /Waiting for first checks/);
  assert.match(html, /No checks yet/);
});

// The section for one service, so a badge check cannot match another service.
const cardOf = (html, name) => html.split('<section class="svc').find((s) => s.includes(`<h2>${name}</h2>`));

test('burndown, burn rate and badges on a service that is down and overspent', async () => {
  const now = Date.now();
  const day = (ago) => new Date(now - ago * 86_400_000).toISOString().slice(0, 10);
  // 12 probes in the last hour, the newest 9 failed: 9 bad against 8.64 allowed.
  const probes = Array.from({ length: 12 }, (_, i) => ({
    ts: now - (12 - i) * 300_000 + 1000, ok: i < 3 ? 1 : 0, status: i < 3 ? 200 : 503, ms: 150, err: null,
  })).reverse();
  const { html } = await page({
    writeups: { probes, days: [{ day: day(0), total: 12, good: 3, fast: 3 }] },
  });
  const w = cardOf(html, 'CTF writeups');
  // Every badge pairs an icon with its word.
  assert.match(w, /class="pill bad"><svg class="icon"[^]*?<\/svg>Down<\/span>/);
  // The burndown is not clipped at zero: the overspend is labelled on the chart.
  assert.match(w, /class="lbl end bad[^"]*"[^>]*>overspent by 4\.2%</);
  assert.match(w, /It ran out on /);
  // The lead sentence comes from the same numbers: down since the first of the 9 failures.
  assert.match(w, /<p class="lead">Down for 45 minutes\. It has used more than its whole downtime allowance for the last 30 days\.<\/p>/);
  // 9 of 12 failed in the last hour at a 99.9% SLO is 750x; 1.0x is explained in words.
  assert.match(w, /Spending rate, 1 h[^]*?<b>750x<\/b>/);
  assert.match(w, /1\.0x = on pace/);
  // The latency line breaks at failures and marks each one with a tick.
  assert.equal((w.match(/V88/g) ?? []).length, 9);
  // The top row names the worst service on each number and links down to it.
  const top = html.slice(html.indexOf('aria-labelledby="fleet"'), html.indexOf('<section class="svc'));
  assert.match(top, /Services up[^]*?0 <small>of 3<\/small>/);
  assert.match(top, /Lowest up time[^]*?25\.00%[^]*?href="#writeups">CTF writeups</);
  assert.match(top, /Least allowance left[^]*?4\.2% <small>over<\/small>[^]*?Overspent/);
  assert.match(top, /Fastest spending, 1 h[^]*?750x[^]*?Over 10x the pace/);
});

test('a probe older than 3 intervals is Stale, never Up, and the banner counts it', async () => {
  const now = Date.now();
  const up = (ago, ms = 120) => ({ probes: [{ ts: now - ago, ok: 1, status: 200, ms, err: null }], days: [] });
  const H = 60 * 60 * 1000;
  const { html } = await page({ portfolio: up(60_000), writeups: up(60_000), hulog: up(3 * H + 60_000, 36_600) });
  const hulog = cardOf(html, 'Hulog');
  assert.match(hulog, /<span class="pill none"><svg[^]*?<\/svg>Stale<\/span>/);
  assert.doesNotMatch(hulog, />Up</);
  assert.match(hulog, /No check for 3 hours, so its current state is unknown\./);
  assert.match(hulog, /Checked <time[^>]*>3 hours ago<\/time>/);
  assert.match(hulog, /<b>HTTP 200 in 36\.6 s<\/b>/);
  assert.match(hulog, /From GitHub Actions, started by this monitor</);
  assert.match(html, /<section class="banner none"[^]*1 service stale/);
  assert.match(html, /Stale, no recent check: Hulog\./);
  assert.doesNotMatch(html, /All services operational/);

  // Just inside 3 intervals it is still a normal result.
  const fresh = await page({ portfolio: up(60_000), writeups: up(60_000), hulog: up(3 * H - 60_000, 36_600) });
  assert.match(cardOf(fresh.html, 'Hulog'), /<span class="pill good"><svg[^]*?<\/svg>Up<\/span>/);
  assert.match(fresh.html, /All services operational/);

  // The 5-minute sites go Stale after 15 minutes without a probe.
  const cron = await page({ portfolio: up(16 * 60_000), writeups: up(60_000), hulog: up(60_000, 36_600) });
  assert.match(cardOf(cron.html, 'Portfolio'), /<span class="pill none"><svg[^]*?<\/svg>Stale<\/span>/);
});

test('a healthy service leads with one plain sentence built from its numbers', async () => {
  const now = Date.now();
  // 30 full days with 2 failed probes: 99.98% up, 2 of the 8.64 allowed failures spent.
  const days = Array.from({ length: 30 }, (_, i) => ({
    day: new Date(now - i * 86_400_000).toISOString().slice(0, 10), total: 288, good: i < 2 ? 287 : 288, fast: 280,
  }));
  const { html } = await page({ portfolio: { probes: [{ ts: now - 60_000, ok: 1, status: 200, ms: 143, err: null }], days } });
  const p = cardOf(html, 'Portfolio');
  assert.match(p, /<p class="lead">Healthy\. 99\.98% up over 30 days, 33 of 43 minutes of allowed downtime left\.<\/p>/);
  assert.match(p, /33 <small>of 43 min<\/small>/);
  assert.match(p, /<a class="toggle show" href="\?open=portfolio#portfolio"/);
  assert.match(p, /<a class="toggle hide" href="\/#portfolio-top"/);
});

test('?open= opens one known panel, and its value never reaches the page', async () => {
  const data = { writeups: { probes: [{ ts: Date.now() - 60_000, ok: 1, status: 200, ms: 150, err: null }], days: [] } };
  const { html } = await page(data, '/?open=writeups');
  assert.match(html, /<section class="svc good open" id="writeups">/);
  assert.equal((html.match(/ open"/g) ?? []).length, 1);
  // The refresh keeps the selection and never has a #fragment: Chromium treats a
  // refresh to a URL with one as a scroll within the page and stops reloading.
  assert.match(html, /<meta http-equiv="refresh" content="60; url=\/\?open=writeups">/);
  assert.match((await page(data, '/?open=how')).html, /<footer id="how" class="open">/);
  const odd = await page(data, '/?open=%3Cb%3Ex');
  assert.doesNotMatch(odd.html, / open"|<b>x/);
  assert.match(odd.html, /<meta http-equiv="refresh" content="60; url=\/">/);
});

test('every animation and transition sits behind prefers-reduced-motion', async () => {
  const { html } = await page({});
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const gate = '@media (prefers-reduced-motion: no-preference) {';
  const start = css.indexOf(gate);
  assert.ok(start > 0);
  // Cut the gated block out by matching braces; nothing left over may move.
  let depth = 0;
  let end = start;
  do {
    if (css[end] === '{') depth++;
    if (css[end] === '}') depth--;
    end++;
  } while (depth > 0 || end <= start + gate.length);
  const ungated = css.slice(0, start) + css.slice(end);
  assert.doesNotMatch(ungated, /(animation|transition|scroll-behavior)(-[a-z]+)?\s*:/);
  assert.match(css.slice(start, end), /animation: drain 60s linear/);
});
