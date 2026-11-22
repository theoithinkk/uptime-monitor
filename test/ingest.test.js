import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const TOKEN = 'test-only-token-not-a-real-secret';
const MIN = 60_000;
const good = { target: 'hulog', ok: true, status: 200, ms: 36_600, err: null };

// Stands in for D1 on the write path. Like record()'s SQL, a batch is refused
// as a whole when the target already has a probe inside the quiet window.
function fakeDB(probes = []) {
  const db = {
    probes,
    batches: [],
    prepare: (sql) => ({
      bind: (...args) => ({
        sql,
        args,
        // alertIfChanged: newest probes first, LIMIT ?2.
        all: async () => ({
          results: db.probes.filter((p) => p.target === args[0]).sort((a, b) => b.ts - a.ts).slice(0, args[1]),
        }),
      }),
    }),
    batch: async (stmts) => {
      db.batches.push(stmts);
      const [target, ts, quiet] = stmts[0].args;
      const blocked = db.probes.some((p) => p.target === target && p.ts > ts - quiet);
      return stmts.map(({ sql, args }) => {
        if (!blocked && sql.includes('INSERT INTO probes')) {
          db.probes.push({ target, ts, ok: args[3], status: args[4], ms: args[5], err: args[6] });
        }
        return { meta: { changes: blocked ? 0 : 1 } };
      });
    },
  };
  return db;
}

async function post(body, { token = TOKEN, env = { INGEST_TOKEN: TOKEN, DB: fakeDB() }, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token !== null) h.authorization = `Bearer ${token}`;
  const res = await worker.fetch(new Request('http://localhost/ingest', {
    method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env);
  return { res, text: await res.text(), env };
}

test('503 and nothing written when INGEST_TOKEN is not set', async () => {
  const DB = fakeDB();
  const { res } = await post(good, { env: { DB } });
  assert.equal(res.status, 503);
  assert.equal(DB.batches.length, 0);
});

test('401 for a wrong, missing or malformed token', async () => {
  const DB = fakeDB();
  const env = { INGEST_TOKEN: TOKEN, DB };
  for (const opts of [{ token: 'wrong' }, { token: `${TOKEN}x` }, { token: '' }, { token: null },
    { token: null, headers: { authorization: TOKEN } }]) {
    const { res } = await post(good, { ...opts, env });
    assert.equal(res.status, 401, JSON.stringify(opts));
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  }
  assert.equal(DB.batches.length, 0);
});

test('404 for any target that is not external', async () => {
  const DB = fakeDB();
  for (const target of ['portfolio', 'nope', 'constructor', '__proto__']) {
    const { res } = await post({ ...good, target }, { env: { INGEST_TOKEN: TOKEN, DB } });
    assert.equal(res.status, 404, target);
  }
  assert.equal(DB.batches.length, 0);
});

test('400 with a reason for malformed bodies, and nothing written', async () => {
  const DB = fakeDB();
  const { ms, ...noMs } = good;
  const bad = [
    'not json', '[]', 'null', '"hulog"',
    { ...good, ts: 1 }, // a client timestamp is refused, not silently used
    noMs,
    { ...good, target: 7 },
    { ...good, ok: 'true' },
    { ...good, status: 99 }, { ...good, status: 600 }, { ...good, status: 200.5 }, { ...good, status: '200' },
    { ...good, ms: -1 }, { ...good, ms: 90_001 }, { ...good, ms: 1.5 },
    { ...good, ok: false, err: 'x'.repeat(201) }, { ...good, err: 5 },
    { ...good, status: 503 }, // ok true needs a 2xx
    { ...good, ok: false, status: null, err: null },
  ];
  for (const body of bad) {
    const { res, text } = await post(body, { env: { INGEST_TOKEN: TOKEN, DB } });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(text.length > 1 && text.length < 120, text);
  }
  assert.equal(DB.batches.length, 0);
});

test('413 for a body over 1 KB, by header or by real length', async () => {
  const DB = fakeDB();
  const env = { INGEST_TOKEN: TOKEN, DB };
  const big = JSON.stringify({ ...good, err: 'x'.repeat(1100) });
  assert.equal((await post(big, { env })).res.status, 413);
  assert.equal((await post(good, { env, headers: { 'content-length': '5000' } })).res.status, 413);
  assert.equal(DB.batches.length, 0);
});

test('204 records the result with the Worker clock and keeps the security headers', async () => {
  const DB = fakeDB();
  const before = Date.now();
  const { res, text } = await post({ ...good, ok: false, status: null, err: 'timeout after 90 s', ms: 90_000 },
    { env: { INGEST_TOKEN: TOKEN, DB } });
  assert.equal(res.status, 204);
  assert.equal(text, '');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  assert.equal(DB.batches.length, 1);
  const [daily, raw] = DB.batches[0];
  assert.match(raw.sql, /INSERT INTO probes/);
  const [target, ts, quiet, ok, status, ms, err] = raw.args;
  assert.deepEqual([target, quiet, ok, status, ms, err], ['hulog', 30 * MIN, 0, null, 90_000, 'timeout after 90 s']);
  assert.ok(ts >= before && ts <= Date.now());
  assert.match(daily.sql, /INSERT INTO daily/);
  assert.equal(daily.args[3], new Date(ts).toISOString().slice(0, 10));
});

test('429 while the newest probe is under 30 minutes old', async () => {
  const now = Date.now();
  const recent = fakeDB([{ target: 'hulog', ts: now - 10 * MIN, ok: 1, status: 200, ms: 100, err: null }]);
  const r1 = await post(good, { env: { INGEST_TOKEN: TOKEN, DB: recent } });
  assert.equal(r1.res.status, 429);
  assert.equal(recent.probes.length, 1);

  const old = fakeDB([{ target: 'hulog', ts: now - 31 * MIN, ok: 1, status: 200, ms: 100, err: null }]);
  const env = { INGEST_TOKEN: TOKEN, DB: old };
  assert.equal((await post(good, { env })).res.status, 204);
  assert.equal((await post(good, { env })).res.status, 429); // the one just written now blocks the next
  assert.equal(old.probes.length, 2);
});

test('GET /ingest is 405, and other paths keep their old answers', async () => {
  const res = await worker.fetch(new Request('http://localhost/ingest'), {});
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await worker.fetch(new Request('http://localhost/ingest/x', { method: 'POST' }), {})).status, 404);
  assert.equal((await worker.fetch(new Request('http://localhost/', { method: 'POST' }), {})).status, 405);
});

test('the scheduled handler never fetches Hulog, whatever cron fires', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return new Response('ok');
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const DB = fakeDB();
  for (const cron of ['*/5 * * * *', '7 * * * *', '0 * * * *']) await worker.scheduled({ cron }, { DB });
  assert.deepEqual(urls.sort(), ['https://theoith.ink/', 'https://writeups.theoith.ink/']);
  assert.equal(DB.probes.some((p) => p.target === 'hulog'), false);
});
