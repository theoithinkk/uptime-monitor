# theo-uptime

A small Cloudflare Worker that probes my three sites, measures them against written SLOs, shows the result on a status page and sends a Telegram alert when one goes down.

The SLOs themselves are in [SLO.md](SLO.md).

## How it works

1. Two Cron Triggers fire the Worker: every 5 minutes and every hour.
2. The Worker probes every target whose cron matches, in parallel. A probe is a GET with a timeout, timed up to the response headers. It is up when the site answers 2xx within the timeout.
3. Each result is written as two statements in one D1 batch. One adds the raw row to `probes`. The other adds 1 to that day's rollup in `daily`. A batch runs as one transaction, so the two can never disagree.
4. The Worker then reads that target's last 3 probes and decides if the state changed. If it did, it sends a DOWN or RECOVERED message to Telegram.
5. `GET /` builds a status page on the server from the rollups. It has no JavaScript.

| File | Purpose |
|---|---|
| `src/index.js` | The Worker: targets, probing, D1 writes, alerts and the status page |
| `src/slo.js` | Pure SLO math: SLI ratios, error budget, p95 and the alert decision |
| `test/slo.test.js` | Unit tests for `slo.js`, run with Node's built-in test runner |
| `schema.sql` | The two D1 tables, `probes` and `daily` |
| `wrangler.toml` | Worker name, cron schedule and the D1 binding |
| `SLO.md` | The written SLOs and the error budget policy |

## Run it locally

Needs Node 20 or newer. Everything here stays on your laptop.

```powershell
cd $env:USERPROFILE\Documents\uptime-monitor
npm install
npm test
npm run db:local
npm run dev
```

`npm run dev` serves the Worker at http://localhost:8787 and lets you fire the crons by hand. In a second PowerShell window:

```powershell
curl.exe "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
curl.exe "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
npx wrangler d1 execute uptime --local --command "SELECT * FROM probes"
npx wrangler d1 execute uptime --local --command "SELECT * FROM daily"
curl.exe -i http://localhost:8787/
```

Then open http://localhost:8787/ in a browser. The Hulog probe can take about 40 seconds if Hulog is asleep.

Two things differ from production. Locally the probes leave from your laptop, so the times are your connection's, not Cloudflare's. And with no Telegram secrets set, an alert is only logged as `alert skipped`. To get real alerts locally, put `TELEGRAM_TOKEN=...` and `TELEGRAM_CHAT_ID=...` in a `.dev.vars` file. Git ignores that file.

## Deploy

Run these yourself. They log in to Cloudflare and create real resources.

1. Log in and create the database:

   ```powershell
   npx wrangler login
   npx wrangler d1 create uptime
   ```

2. Copy the `database_id` it prints into `wrangler.toml`, replacing the placeholder.
3. Create the tables in the real database:

   ```powershell
   npx wrangler d1 execute uptime --remote --file=schema.sql
   ```

4. Make a Telegram bot. In Telegram, talk to BotFather, send `/newbot` and copy the token. Send your new bot any message. Then get your chat id without putting the token in browser history:

   ```powershell
   $token = Read-Host "Bot token"
   (Invoke-RestMethod "https://api.telegram.org/bot$token/getUpdates").result[0].message.chat.id
   ```

5. Store both as Worker secrets. Each command asks for the value:

   ```powershell
   npx wrangler secret put TELEGRAM_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```

6. Deploy, then watch the first cron run:

   ```powershell
   npx wrangler deploy
   npx wrangler tail
   ```

The status page is then at `https://theo-uptime.<your-subdomain>.workers.dev/`.

## Design decisions

**D1, not KV.** KV's free plan allows 1,000 writes a day. This needs about 1,200: 600 probes a day, two writes each. KV also can't sum or sort, and it is eventually consistent, while the alert check reads back the rows it just wrote. D1 is SQLite, allows 100,000 writes a day for free, and can sort rows and bump counters in SQL.

**Daily rollups.** D1's free plan allows 5 million rows read a day. Working out 30-day SLOs from raw rows means reading about 18,000 rows on every page view, which allows only about 270 views a day. The `daily` table keeps one row per target per day, so a page view reads about 700 rows: 30 daily rows per target, plus 24 hours of raw rows for p95. Each page query filters on the table's primary key prefix (`target`), so SQLite reads only the rows it needs and never scans the whole table.

**Hulog is probed hourly.** Hulog runs on Render's free tier, which sleeps after 15 idle minutes. A 5-minute probe would keep it awake all the time. That would use about 720 of the 750 free hours a month, and it would hide the cold start real users hit. Hourly probes mostly find it asleep, so Hulog's latency SLI is really a cold-start SLI. The 90 second timeout is fine on a Worker: a Cron Trigger may run for up to 15 minutes of wall time, and waiting on a fetch uses no CPU time.

**Alert after 2 failures in a row.** One failed probe is often a network blip. Paging on blips teaches you to ignore the pager. `FAILS_BEFORE_ALERT = 2` means DOWN fires on the second failure in a row, once per outage, and RECOVERED fires on the first success after it. The cost is slower detection: up to about 10 minutes for the sites and 2 hours for Hulog. The decision is a pure function, so the tests cover every transition.

**Shared fate, stated openly.** The probes run on Cloudflare, and two of the three sites are hosted on Cloudflare. If Cloudflare goes down, the sites, this page and the alerts can all go down together. The status page footer says so. The fix is a second probe from outside Cloudflare, listed below.

**Page hardening.** The page sends a CSP that allows no scripts at all, so even an injected tag can't run. Every value from the database is HTML-escaped. The page also sends `nosniff`, `no-referrer` and `frame-ancestors 'none'` against clickjacking. The targets are hardcoded, so no request can make the Worker fetch a URL of its choosing. The Telegram token lives only in a Worker secret and is never logged.

**Timing.** Workers freeze `Date.now()` while code runs and move it forward on I/O. Cloudflare does that to blunt Spectre-style timing attacks. It also means the measured time is network time to the response headers, not time spent in my code.

**Pure logic in its own file.** `slo.js` has no Worker APIs, so plain Node can test it with no extra dependencies. `index.js` only imports from it and exports nothing but the handlers, because workerd reads the main module's named exports as entry points and may reject anything else.

## Skipped, and when to add it

- **A second probe from outside Cloudflare**, such as a GitHub Actions cron. Add it to break shared fate, before I rely on this for anything that matters.
- **Multi-window burn-rate alerts.** Add them once there is real traffic and a slow burn of the budget is worth catching early. With three small sites, 2 failures in a row is enough.
- **Content checks.** A 200 is not proof the right page loaded. A broken deploy or a parked domain can answer 200. Add a check for a known string in the page the first time that happens, or before the sites carry anything important.
- **Pruning.** About 600 rows a day is about 20 MB a year, against 500 MB per database on D1's free plan. Add a daily delete of raw probes older than 90 days when the database passes 250 MB. The daily rollups stay.
- **Re-sending a missed alert.** An alert fires only on the change of state. If Telegram is down at that moment, the alert is lost. Add an `alerts` table with a retry once that ever happens.
- **Project Sinag.** Add it as a fourth target with its own SLO once it goes live.
