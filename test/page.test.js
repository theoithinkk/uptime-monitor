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
      return { results: d.probes.filter((p) => p.ok).map((p) => ({ ms: p.ms })) };
    }),
  };
}

async function page(data) {
  const res = await worker.fetch(new Request('http://localhost/'), { DB: fakeDB(data) });
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
  assert.match(html, /No probes yet/); // hulog has no rows
});

test('status page with no probes at all says it is waiting', async () => {
  const { html } = await page({});
  assert.match(html, /Waiting for first probes/);
});
