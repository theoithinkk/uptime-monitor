import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAILS_BEFORE_ALERT, sum, availability, latency,
  budgetRemaining, budgetMinutes, percentile, alertFor,
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
