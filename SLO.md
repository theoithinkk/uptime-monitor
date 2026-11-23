# Service level objectives

These are the written SLOs for my three public services. The Worker in this repo measures them, and the status page shows them.

## How every SLO here is measured

- **Probe:** a GET request that follows redirects and is timed up to the response headers. The two sites are probed from a Cloudflare Cron Trigger. Hulog is probed from a GitHub Actions job that the Worker starts every hour, timed to the first byte of the response, which then sends the result to the Worker.
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
| Probe | every hour from GitHub Actions, started by the Worker at minute 5 (GitHub's own schedule at minute 7 is a backup), 90 s timeout, 720 probes per window. It probes `/`, because `/api/health` returns 404. |
| Availability SLO | 99% |
| Error budget | 7.2 probes, which is 7.2 hours (432 minutes). 7 failed hourly probes keep the SLO; the 8th breaks it. |
| Latency SLO | 95% of good probes under 60 s, so 36 slow probes per window |

**Why these targets.** Hulog runs on Render's free tier, which sleeps after 15 idle minutes. Hourly probes let it sleep, so most probes find it asleep and measure a cold start. On 2026-11-22 a cold start answered 200 in 36.6 s. The 60 s threshold is about 1.6 times that. The 95% target accepts that free-tier wake times vary. The 90 s timeout sits above the threshold, so a wake between 60 and 90 s counts as up but slow. It spends latency budget, not availability budget. 99% availability fits a single free instance that sleeps and restarts. At 99.9% the budget would be 0.72 probes, so one failed probe would break the SLO.

**Paused 2026-11-22.** The first live probe, at 08:00 UTC, got HTTP 429 in 248 ms. A test from a Cloudflare data center then got the same 429 in 10 ms, with `cf-mitigated: challenge` and a "Just a moment..." page, whether the User-Agent was the monitor's or a browser's. The bot check in front of onrender.com blocks requests sent from Cloudflare Workers, so the probe measured that block and never reached Hulog. I deleted that one probe and its daily row, because they describe the block, not Hulog. Hulog is not probed until it can be probed from outside Cloudflare, and this SLO starts counting again from that date. I will not try to get around the bot check: the probe would then measure something no real visitor does.

**Probed from GitHub Actions, 2026-11-22.** Hulog is now probed every hour, at minute 7, by a GitHub Actions job (`.github/workflows/probe-hulog.yml`). It sends each result to the Worker, which stamps it with its own clock and records it like any other probe. This SLO counts again from the first GitHub probe; the window holds no Hulog data from before it. The targets above are unchanged. Caveats:

- **GitHub's network is not a real user's.** The runner sits in a data center with a fast link, so its times are closer to the best case than to a visitor on a phone. The cold start, which dominates Hulog's latency, is the same for both.
- **Scheduled runs can be late or skipped.** GitHub starts scheduled jobs late when it is busy, and can drop them. A skipped run is missing data, not a failure: it adds nothing to the probe count and spends no budget. If no probe arrives for 3 hours, the status page shows Hulog as Stale instead of showing an old result as current.
- **The bot check could reach GitHub too.** If a probe gets `cf-mitigated: challenge`, the job records nothing and fails, so the bot check can never count as Hulog being down.
- **The 60-day rule.** GitHub turns off scheduled workflows in a public repo after 60 days with no activity in the repo. Until it is turned back on, there are no probes and Hulog shows as Stale. Those hours are missing data, not downtime.

**Started by the Worker, 2026-11-23.** GitHub ran only 2 of about 15 scheduled runs in the first 15 hours (18:24 UTC on 2026-11-22 and 00:09 UTC on 2026-11-23), so Hulog showed as Stale most of the time. A run started by hand began at once. The Worker now starts the workflow at minute 5 of every hour through GitHub's API, and the workflow's own schedule at minute 7 stays as a backup. When both land in the same half hour, only the first result is recorded. The probe, the targets and the window are unchanged. Caveats:

- **The start shares fate with Cloudflare.** If Cloudflare is down, the hourly start stops too. GitHub's schedule is still there as a backup, but its results go to the Worker as well, so they are only recorded while Cloudflare answers.
- **A skipped hour is still missing data.** If a start fails (GitHub refuses it, or the token has expired), that hour adds nothing to the probe count and spends no budget. After 3 hours without a probe the page shows Hulog as Stale, never as down.

## Error budget policy

This is a solo project, so the policy is short enough that I will actually follow it.

1. **Budget left:** ship as normal.
2. **Budget spent** (0% or less on the status page): stop feature deploys to that service. Only fixes, rollbacks and reliability work go out until its 30-day availability is back above the SLO, which happens as the bad days roll out of the window.
3. **Postmortem:** any single outage longer than the whole budget gets a written postmortem in `postmortems/YYYY-MM-DD-service.md`. That means longer than 43 minutes for the two sites, or 8 failed hourly probes in a row for Hulog. It covers the timeline, how I found out, the root cause and what I changed. It is blameless, even with one person.
4. **Outages I can't fix** (a Cloudflare or Render incident) still spend the budget and still get written down. If they keep happening, I change the hosting or the SLO on purpose, with a dated note here. I don't quietly move the numbers.
5. **Review:** after the first 30 days of real data, compare each target with what was measured, and record any change here with the date.
