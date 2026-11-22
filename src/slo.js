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

// Burn rate: a window's error rate divided by the error rate the SLO allows.
// 1 spends the budget exactly on pace to run out at the end of the 30 days;
// 10 would spend a whole window's budget in 3 days. null with no probes.
export function burnRate(total, bad, slo) {
  return total > 0 && slo < 1 ? bad / total / (1 - slo) : null;
}

// Budget left after each day of the window, oldest first, for the burndown.
// bads[i] is day i's failed probes, 0 for a day with no data: missing data spends
// nothing. allowed is the full window's budget in probes, the same one
// budgetRemaining uses, so the last value always matches the headline number.
// Never clamped: an overspent budget goes below 0.
export function burndown(bads, allowed) {
  if (!(allowed > 0)) return null;
  let spent = 0;
  return bads.map((bad) => 1 - (spent += bad) / allowed);
}

// Burn rate for each hour of a window, oldest first, for a sparkline. probes are
// { ts, ok }; hour i covers [start + i h, start + (i + 1) h). An hour with fewer
// than min probes is null: one failure in two probes is not a rate worth drawing.
export function hourlyBurn(probes, slo, start, hours, min) {
  const HOUR = 60 * 60 * 1000;
  const n = Array(hours).fill(0);
  const bad = Array(hours).fill(0);
  for (const p of probes) {
    const i = Math.floor((p.ts - start) / HOUR);
    if (i < 0 || i >= hours) continue;
    n[i]++;
    if (!p.ok) bad[i]++;
  }
  return n.map((total, i) => (total < min ? null : burnRate(total, bad[i], slo)));
}

// The fleet summary: the service that is worst on each SLO number, so the top of
// the page says where to look first. items are { avail, slo, left, burn } plus
// anything the caller wants back, with null for no data; null never wins. Ties keep
// the first item. lowest ranks by distance from each service's own goal, so a 99%
// service at 99.5% is better off than a 99.9% service at 99.8%.
export function fleet(items) {
  const worst = (score) => {
    let pick = null;
    let low = Infinity;
    for (const x of items) {
      const s = score(x);
      if (s !== null && s < low) [pick, low] = [x, s];
    }
    return pick;
  };
  return {
    lowest: worst((x) => (x.avail === null ? null : x.avail - x.slo)),
    atRisk: worst((x) => x.left),
    hottest: worst((x) => (x.burn === null ? null : -x.burn)),
  };
}

// Nearest-rank percentile, p in 1..100. The answer is always a real sample.
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p * sorted.length) / 100); // 1-based
  return sorted[Math.max(rank, 1) - 1];
}

// When the current outage started: the ts of the first failure in the newest run of
// failed probes, or null when the newest probe is ok. probes is oldest first.
// whole is true when every probe given failed, so the outage may be older than the list.
export function failingSince(probes) {
  let i = probes.length;
  while (i > 0 && !probes[i - 1].ok) i--;
  return i === probes.length ? null : { ts: probes[i].ts, whole: i === 0 };
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
