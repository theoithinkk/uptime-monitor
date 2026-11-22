// Pure SLO math. No Worker APIs in here, so Node can test every line.

// Fails in a row before a DOWN alert. 2 means one blip never pages.
export const FAILS_BEFORE_ALERT = 2;

// Add up daily rollup rows ({ total, good, fast }) into one window.
export function sum(days) {
  const out = { total: 0, good: 0, fast: 0 };
  for (const d of days) {
    out.total += d.total;
    out.good += d.good;
    out.fast += d.fast;
  }
  return out;
}

// Availability SLI: good probes / all probes. null when there is no data.
export function availability({ total, good }) {
  return total > 0 ? good / total : null;
}

// Latency SLI: fast probes / good probes. A failed probe has no useful latency,
// so it counts against availability only, never twice.
export function latency({ good, fast }) {
  return good > 0 ? fast / good : null;
}

// Share of the error budget left: 1 is untouched, 0 is spent, below 0 is overspent.
// allowed bad = (1 - slo) * total, remaining = 1 - bad / allowed.
export function budgetRemaining(slo, total, bad) {
  const allowed = (1 - slo) * total;
  return allowed > 0 ? 1 - bad / allowed : null;
}

// The whole error budget as minutes of downtime over the window.
// 99.9% over 30 days is 43.2 minutes.
export function budgetMinutes(slo, days = 30) {
  return (1 - slo) * days * 24 * 60;
}

// Nearest-rank percentile, p in 1..100. The answer is always a real sample.
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p * sorted.length) / 100); // 1-based
  return sorted[Math.max(rank, 1) - 1];
}

// How many probes in a row failed, starting at index `from`. Newest first.
function failsFrom(oks, from) {
  let i = from;
  while (i < oks.length && !oks[i]) i++;
  return i - from;
}

// Decide if the newest probe changed the alert state.
// `oks` is the target's latest FAILS_BEFORE_ALERT + 1 results, newest first.
//   DOWN:      the newest N failed and the one before them was ok or missing.
//              Exactly N, so a long outage alerts once, not on every probe.
//   RECOVERED: the newest is ok and the N before it failed, so a DOWN was sent.
export function alertFor(oks) {
  if (failsFrom(oks, 0) === FAILS_BEFORE_ALERT) return 'DOWN';
  if (oks[0] && failsFrom(oks, 1) >= FAILS_BEFORE_ALERT) return 'RECOVERED';
  return null;
}
