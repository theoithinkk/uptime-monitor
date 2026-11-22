import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAILS_BEFORE_ALERT, sum, availability, latency,
  budgetRemaining, budgetMinutes, percentile, alertFor, burnRate, burndown, failingSince,
} from '../src/slo.js';

const close = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not close to ${expected}`);

test('SLI ratios from daily rollups', () => {
  const window = sum([
    { total: 288, good: 287, fast: 280 },
    { total: 288, good: 288, fast: 288 },
  ]);
  assert.deepEqual(window, { total: 576, good: 575, fast: 568 });
  close(availability(window), 575 / 576);
  close(latency(window), 568 / 575);
});

test('SLIs are null with no data, so the page can say so', () => {
  assert.equal(availability(sum([])), null);
  assert.equal(latency({ good: 0, fast: 0 }), null);
  assert.equal(budgetRemaining(0.999, 0, 0), null);
});

test('error budget: 99.9% over 8640 probes with 4 bad leaves about 53.7%', () => {
  // allowed = 0.001 * 8640 = 8.64 bad probes, remaining = 1 - 4 / 8.64
  close(budgetRemaining(0.999, 8640, 4), 0.537, 0.001);
  close(budgetRemaining(0.999, 8640, 0), 1);
  assert.ok(budgetRemaining(0.999, 8640, 9) < 0, 'overspent goes below zero');
});

test('error budget in minutes', () => {
  close(budgetMinutes(0.999), 43.2);
  close(budgetMinutes(0.99), 432); // Hulog: 7.2 hourly probes
});

test('burn rate: 1 is exactly on pace, failures in a short window burn fast', () => {
  close(burnRate(1000, 1, 0.999), 1); // 0.1% errors against a 0.1% allowance
  assert.equal(burnRate(288, 0, 0.999), 0);
  close(burnRate(12, 9, 0.999), 750); // 9 of the last 12 probes failed
  close(burnRate(24, 1, 0.99), 1 / 24 / 0.01); // Hulog: one failed hourly probe in a day
  assert.equal(burnRate(0, 0, 0.999), null);
  assert.equal(burnRate(10, 0, 1), null); // a 100% SLO allows no errors, so no rate
});

test('burndown: budget left after each day, flat on days with no data, never clamped', () => {
  const allowed = 0.001 * 30 * 288; // 8.64 probes, the full-window budget
  const bads = Array(30).fill(0);
  bads[4] = 1;
  bads[11] = 1;
  const left = burndown(bads, allowed);
  assert.equal(left.length, 30);
  close(left[3], 1);
  close(left[4], 1 - 1 / 8.64);
  close(left[10], left[4]); // nothing spent in between
  // The last point is the headline figure on the page.
  close(left[29], budgetRemaining(0.999, 30 * 288, 2));

  const over = burndown([0, 3, 18], allowed);
  close(over[1], 1 - 3 / 8.64);
  close(over[2], 1 - 21 / 8.64);
  assert.ok(over[2] < -1, 'overspend goes below zero');
  assert.equal(burndown([1], 0), null);
});

test('nearest-rank p95', () => {
  const ms = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
  assert.equal(percentile(ms, 95), 190); // rank ceil(0.95 * 20) = 19
  assert.equal(percentile([300, 100, 200], 95), 300); // unsorted input, rank 3
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([], 95), null);
});

test('alerts: no alert on 1 fail, DOWN on the 2nd, no repeat, RECOVERED on the first ok', () => {
  assert.equal(FAILS_BEFORE_ALERT, 2);
  // Probe results in time order. After each one, feed the newest 3, newest first,
  // like the Worker's ORDER BY ts DESC LIMIT 3.
  const history = [1, 0, 0, 0, 1, 1];
  const alerts = history.map((_, i) =>
    alertFor(history.slice(0, i + 1).reverse().slice(0, FAILS_BEFORE_ALERT + 1)));
  assert.deepEqual(alerts, [null, null, 'DOWN', null, 'RECOVERED', null]);
});

test('alerts: a single blip never pages either way', () => {
  assert.equal(alertFor([1, 0, 1]), null);
  assert.equal(alertFor([0, 1, 1]), null);
});

test('alerts: a brand new target that fails twice goes DOWN', () => {
  assert.equal(alertFor([0]), null);
  assert.equal(alertFor([0, 0]), 'DOWN');
  assert.equal(alertFor([]), null);
});

test('outage start: first failure of the newest failed run', () => {
  const p = (ts, ok) => ({ ts, ok });
  assert.equal(failingSince([]), null);
  assert.equal(failingSince([p(1, 0), p(2, 1)]), null); // newest is ok
  assert.deepEqual(failingSince([p(1, 0), p(2, 1), p(3, 0), p(4, 0)]), { ts: 3, whole: false });
  // Every probe failed: it started at or before the oldest one shown.
  assert.deepEqual(failingSince([p(1, 0), p(2, 0)]), { ts: 1, whole: true });
});
