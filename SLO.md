# Service level objectives

These are the written SLOs for my three public services. The Worker in this repo measures them, and the status page shows them.

## How every SLO here is measured

- **Probe:** a GET request from a Cloudflare Cron Trigger. It follows redirects and is timed up to the response headers.
- **Availability SLI:** probes that answered 2xx within the timeout, divided by all probes.
- **Latency SLI:** good probes that answered under the latency threshold, divided by good probes. A failed probe counts against availability only, never twice.
- **Window:** rolling 30 days, counted in UTC days, today included. 30 days is 43,200 minutes.
- **Error budget:** the number of probes allowed to fail in a full window, (1 − SLO) × the window's probes. Each probe stands for its interval, so the budget can also be read as minutes of downtime.

The budget is always counted against a full 30-day window, even before 30 days of data exist, so a failed probe on day one costs the same 5 minutes it would on day 30. Availability is the ratio over the probes made so far, so in the first days it can read below the SLO while budget is still left.

## Portfolio (theoith.ink)

**User journey:** a recruiter opens https://theoith.ink/ and the home page loads.

| | |
|---|---|
| Probe | every 5 minutes, 10 s timeout, 8,640 probes per window |
| Availability SLO | 99.9% |
| Error budget | 43.2 minutes, which is 8.64 probes. 8 failed probes keep the SLO; the 9th breaks it. |
| Latency SLO | 99% of good probes under 1000 ms, so about 86 slow probes per window |

**Why these targets.** On 2026-11-22 the page answered 200 in 0.48 s from Manila. It is a static site on Cloudflare Pages with no server of its own to crash, so 99.9% is a fair bar that a bad deploy or a DNS mistake would still break. I did not pick 99.99%: its budget is 4.3 minutes, which is less than one 5-minute probe interval. A single failed probe would blow the whole budget, so a 5-minute probe can't measure that target honestly. The 1000 ms threshold gives about twice the measured time as headroom. Probes from inside Cloudflare should be faster than that, so a miss points to a real problem, not a slow network.

## CTF writeups (writeups.theoith.ink)

**User journey:** a reader opens https://writeups.theoith.ink/ and the writeups load.

| | |
|---|---|
| Probe | every 5 minutes, 10 s timeout, 8,640 probes per window |
| Availability SLO | 99.9% |
| Error budget | 43.2 minutes, which is 8.64 probes. 8 failed probes keep the SLO; the 9th breaks it. |
| Latency SLO | 99% of good probes under 1000 ms, so about 86 slow probes per window |

**Why these targets.** On 2026-11-22 it answered 200 in 0.59 s from Manila. It is also static and hosted on Cloudflare, so it gets the same targets as the portfolio for the same reasons.

## Hulog (hulog.onrender.com)

**User journey:** a user opens https://hulog.onrender.com/ and the front page loads, even if the server was asleep.

| | |
|---|---|
| Probe | every hour, 90 s timeout, 720 probes per window. It probes `/`, because `/api/health` returns 404. |
| Availability SLO | 99% |
| Error budget | 7.2 probes, which is 7.2 hours (432 minutes). 7 failed hourly probes keep the SLO; the 8th breaks it. |
| Latency SLO | 95% of good probes under 60 s, so 36 slow probes per window |

**Why these targets.** Hulog runs on Render's free tier, which sleeps after 15 idle minutes. Hourly probes let it sleep, so most probes find it asleep and measure a cold start. On 2026-11-22 a cold start answered 200 in 36.6 s. The 60 s threshold is about 1.6 times that. The 95% target accepts that free-tier wake times vary. The 90 s timeout sits above the threshold, so a wake between 60 and 90 s counts as up but slow. It spends latency budget, not availability budget. 99% availability fits a single free instance that sleeps and restarts. At 99.9% the budget would be 0.72 probes, so one failed probe would break the SLO.

**Paused 2026-11-22.** The first live probe, at 08:00 UTC, got HTTP 429 in 248 ms. A test from a Cloudflare data center then got the same 429 in 10 ms, with `cf-mitigated: challenge` and a "Just a moment..." page, whether the User-Agent was the monitor's or a browser's. The bot check in front of onrender.com blocks requests sent from Cloudflare Workers, so the probe measured that block and never reached Hulog. I deleted that one probe and its daily row, because they describe the block, not Hulog. Hulog is not probed until it can be probed from outside Cloudflare, and this SLO starts counting again from that date. I will not try to get around the bot check: the probe would then measure something no real visitor does.

## Error budget policy

This is a solo project, so the policy is short enough that I will actually follow it.

1. **Budget left:** ship as normal.
2. **Budget spent** (0% or less on the status page): stop feature deploys to that service. Only fixes, rollbacks and reliability work go out until its 30-day availability is back above the SLO, which happens as the bad days roll out of the window.
3. **Postmortem:** any single outage longer than the whole budget gets a written postmortem in `postmortems/YYYY-MM-DD-service.md`. That means longer than 43 minutes for the two sites, or 8 failed hourly probes in a row for Hulog. It covers the timeline, how I found out, the root cause and what I changed. It is blameless, even with one person.
4. **Outages I can't fix** (a Cloudflare or Render incident) still spend the budget and still get written down. If they keep happening, I change the hosting or the SLO on purpose, with a dated note here. I don't quietly move the numbers.
5. **Review:** after the first 30 days of real data, compare each target with what was measured, and record any change here with the date.
