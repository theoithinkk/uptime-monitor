# theo-uptime

A small Cloudflare Worker that measures my three sites against written SLOs, shows the result on a status page and sends a Telegram alert when one goes down. It probes two of them itself. The third, Hulog, is probed from GitHub Actions: the Worker starts that job every hour, and the job sends its result back to the Worker.

Live at https://status.theoith.ink/. The SLOs themselves are in [SLO.md](SLO.md).

## How it works

1. A Cron Trigger fires the Worker every 5 minutes. (A second one, at minute 5 of every hour, only starts the Hulog probe. See below.)
2. The Worker probes the two Cloudflare-hosted sites in parallel. A probe is a GET with a timeout, timed up to the response headers. It is up when the site answers 2xx within the timeout.
3. Each result is written as two statements in one D1 batch. One adds the raw row to `probes`. The other adds 1 to that day's rollup in `daily`. A batch runs as one transaction, so the two can never disagree.
4. The Worker then reads that target's last 3 probes and decides if the state changed. If it did, it sends a DOWN or RECOVERED message to Telegram.
5. `GET /` builds a status page on the server from the rollups. It has no JavaScript.

### The external probe for Hulog

Hulog runs on Render's free tier at `hulog.onrender.com`. Cloudflare's bot check sits in front of onrender.com, and it answers every request from a Cloudflare Worker with HTTP 429, `cf-mitigated: challenge` and a "Just a moment..." page, in about 10 ms, whatever the User-Agent. A probe from the Worker would measure that block, never Hulog. I won't try to get around the bot check, so Hulog is probed from somewhere else:

1. The Worker starts `.github/workflows/probe-hulog.yml` at minute 5 of every hour (see [Starting the Hulog probe every hour](#starting-the-hulog-probe-every-hour)). It runs on a GitHub-hosted runner and is bash and curl only: no checkout, no third-party actions, `permissions: {}`.
2. It sends a GET to `https://hulog.onrender.com/` with a 90 s timeout and follows redirects, like the Worker's probe. It records the HTTP status and curl's `time_starttransfer`, the time to the first byte of the response. That is the closest match to the Worker's timing up to the response headers.
3. If the response carries `cf-mitigated: challenge`, the job sends nothing and fails. A run that hit the bot check measured the bot check, not Hulog.
4. Otherwise it builds the result as JSON with `jq` and POSTs it to `https://status.theoith.ink/ingest` with a bearer token. The Worker checks it, stamps it with its own clock, and then records it and checks for alerts exactly as for a cron probe.

The ingest contract:

| | |
|---|---|
| Request | `POST /ingest`, header `Authorization: Bearer <INGEST_TOKEN>`, a JSON body of at most 1024 bytes |
| Body | `target`: `"hulog"` (the only external target). `ok`: true or false. `status`: an integer from 100 to 599, or null when no response came back. `ms`: an integer from 0 to the target's timeout (90000). `err`: a string of at most 200 characters, or null. No other fields, so a client timestamp is refused. `ok: true` needs a 2xx status, and `status: null` needs an `err`. |
| 204 | Recorded |
| 400 | Malformed body, with a short plain-text reason |
| 401 | Missing or wrong token |
| 404 | `target` is not an external target |
| 405 | Any method but POST |
| 413 | Body over 1024 bytes |
| 429 | That target already has a probe from the last 30 minutes |
| 503 | `INGEST_TOKEN` is not set on the Worker, so nothing is accepted |

Every response carries the same security headers as the page. `GET /` and the 404 for other paths are unchanged.

A target goes **Stale** on the page when its newest probe is older than 3 of its intervals: 15 minutes for the two sites, 3 hours for Hulog. Its badge turns grey, the card says when the last probe was, and the banner counts it ("1 service stale"). A stale service is never shown as Up.

### Starting the Hulog probe every hour

GitHub's scheduler is best effort: under load it starts scheduled runs late, and it can drop them. In the first 15 hours it ran 2 of about 15 hourly runs, while a run started by hand began at once. Cloudflare's Cron Triggers fire on time, so the Worker now starts the run. Only the start moved: the probe itself still runs on GitHub, outside Cloudflare, and sends its result to `/ingest` as before.

1. A second Cron Trigger, `5 * * * *`, fires the Worker at minute 5 of every hour. On that tick the Worker probes nothing. It sends one request to GitHub's workflow dispatch API:

   ```
   POST https://api.github.com/repos/theoithinkk/uptime-monitor/actions/workflows/probe-hulog.yml/dispatches
   Authorization: Bearer <GH_DISPATCH_TOKEN>
   Accept: application/vnd.github+json
   X-GitHub-Api-Version: 2022-11-28
   User-Agent: theo-uptime/1.0
   Content-Type: application/json

   {"ref":"main"}
   ```

2. GitHub answers 204 and queues a run of the workflow on `main`, which probes Hulog and posts the result.
3. If `GH_DISPATCH_TOKEN` is not set, the Worker logs a warning and sends nothing, so deploying before the token exists is harmless. If GitHub answers anything but 204, or doesn't answer within 10 s, the Worker logs the status and the first 200 characters of GitHub's reply, and stops. It doesn't retry or throw. That hour is missing data, and after 3 hours without a probe the page shows Hulog as Stale, which is the visible signal.
4. Cloudflare fires each Cron Trigger as its own invocation, so at minute 5 the `*/5` run still probes the two sites as usual. The minute-5 run never probes anything, and the `*/5` run never calls GitHub.

**GitHub's own schedule stays as a backup.** The workflow keeps its `7 * * * *` schedule. When both runs happen in the same half hour, the second one's POST to `/ingest` gets a 429, because a target takes at most one result per 30 minutes. The workflow treats a 429 as "already recorded this half hour": it prints a notice and the run ends green. Any other answer but 204 still fails the run.

**Security.**

- The token is a fine-grained personal access token limited to this one repo and one permission, Actions: Read and write (GitHub adds read-only Metadata by itself). It can't push code, change the workflow file, read secrets or reach any other repo. If it leaked, the worst anyone could do is start, cancel or delete runs of this repo's workflow, or disable it, and `/ingest` would still record at most one Hulog result per half hour.
- The URL is hardcoded: owner, repo, workflow file and branch are constants in `src/index.js`. Only the cron handler calls it, so no request to the page can start a run or send the token anywhere else.
- The token lives only in the Worker secret `GH_DISPATCH_TOKEN` and is never logged. The Worker logs only GitHub's status and reply text, and a test checks that no log line contains the token.
- Fine-grained tokens expire. After the expiry date GitHub answers 401, no run is started, and Hulog goes Stale unless the backup schedule happens to run. Rotate the token before it expires (Deploy, step 9).

### Files

| File | Purpose |
|---|---|
| `src/index.js` | The Worker: targets, probing, the hourly Hulog start, `/ingest`, D1 writes, alerts and the status page |
| `src/slo.js` | Pure SLO math: SLI ratios, error budget, burndown, burn rate, p95 and the alert decision |
| `test/slo.test.js` | Unit tests for `slo.js`, run with Node's built-in test runner |
| `test/page.test.js` | Status page tests against a fake D1: escaping, the CSP, the Stale state, the burndown and burn rate |
| `test/ingest.test.js` | `/ingest` tests against a fake D1, the hourly start against a fake fetch, a check that the cron never probes Hulog, and a check that the workflow counts a 429 as recorded |
| `.github/workflows/probe-hulog.yml` | The hourly Hulog probe on GitHub Actions, started by the Worker |
| `schema.sql` | The two D1 tables, `probes` and `daily` |
| `wrangler.toml` | Worker name, the two cron schedules and the D1 binding |
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

`npm run dev` serves the Worker at http://localhost:8787 and lets you fire the cron by hand. In a second PowerShell window:

```powershell
curl.exe "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
npx wrangler d1 execute uptime --local --command "SELECT * FROM probes"
npx wrangler d1 execute uptime --local --command "SELECT * FROM daily"
curl.exe -i http://localhost:8787/
```

Then open http://localhost:8787/ in a browser.

To try `/ingest` locally, put a throwaway `INGEST_TOKEN=local-test` line in `.dev.vars` before `npm run dev`, then post a result. PowerShell 5.1 mangles double quotes in arguments to `curl.exe`, so the body goes in a file:

```powershell
Set-Content -Path body.json -Value '{"target":"hulog","ok":true,"status":200,"ms":35565,"err":null}' -Encoding ascii -NoNewline
curl.exe -i -X POST http://localhost:8787/ingest -H "Authorization: Bearer local-test" -H "Content-Type: application/json" --data-binary "@body.json"
Remove-Item body.json
```

The first post answers 204 and the second 429. Clear the test rows afterwards with `npx wrangler d1 execute uptime --local --command "DELETE FROM probes WHERE target = 'hulog'; DELETE FROM daily WHERE target = 'hulog'"`.

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

A new Cron Trigger can take up to 15 minutes to reach every Cloudflare data center, so the first scheduled run may be skipped.

7. Set up the Hulog probe. The Worker and the GitHub workflow share one secret, `INGEST_TOKEN`. This makes a random 32-byte token (64 hex characters), gives it to both CLIs on stdin, never prints it, and clears it from the session. Run it in Windows PowerShell after the deploy:

   ```powershell
   cd $env:USERPROFILE\Documents\uptime-monitor
   $savedIn, $savedOut = [Console]::InputEncoding, $OutputEncoding
   try {
     # Plain ASCII on the pipe: a UTF-8 console would put a byte order mark before the token.
     [Console]::InputEncoding = New-Object System.Text.ASCIIEncoding
     $OutputEncoding = New-Object System.Text.ASCIIEncoding
     $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
     $bytes = New-Object byte[] 32
     $rng.GetBytes($bytes)
     $rng.Dispose()
     $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
     $token | npx wrangler secret put INGEST_TOKEN
     $token | gh secret set INGEST_TOKEN --repo theoithinkk/uptime-monitor
   } finally {
     [Console]::InputEncoding, $OutputEncoding = $savedIn, $savedOut
     Remove-Variable token, bytes, rng, savedIn, savedOut -ErrorAction SilentlyContinue
   }
   ```

   Both CLIs read the value from stdin when it is piped, and both drop the line ending PowerShell adds: `wrangler secret put` trims trailing whitespace and `gh secret set` trims `\r\n`. The Worker secret takes effect at once, with no redeploy. To rotate the token, run the same block again.

8. Push the workflow, then run it once by hand instead of waiting for the next hour:

   ```powershell
   gh workflow run probe-hulog.yml --repo theoithinkk/uptime-monitor
   gh run watch --repo theoithinkk/uptime-monitor
   ```

   A green run printed `Recorded.` and the status page shows Hulog's first probe. A green run with a notice instead found a result from the last 30 minutes already recorded, which is fine. A red run says why: the bot check answered (nothing was recorded), the status page refused the result (its status and reason are printed), or the secret is missing.

9. Let the Worker start the Hulog probe every hour. Until this is done the Worker only logs a warning at minute 5, and Hulog depends on GitHub's own schedule. It needs a GitHub token that can start this repo's workflows:

   1. On GitHub, open Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token.
   2. Name it `uptime-monitor dispatch`, set Resource owner to `theoithinkk` and pick an expiration date. Note the date: on that day the hourly start stops.
   3. Under Repository access, choose Only select repositories and pick `uptime-monitor`.
   4. Under Repository permissions, set Actions to Read and write. GitHub adds Metadata (read-only) by itself. Leave everything else at No access.
   5. Generate the token and copy it. GitHub shows it only once.
   6. Store it as a Worker secret. The command asks for the value; paste the token at the prompt:

      ```powershell
      cd $env:USERPROFILE\Documents\uptime-monitor
      npx wrangler secret put GH_DISPATCH_TOKEN
      ```

   The secret takes effect at once, with no redeploy. To check that it worked, wait until a few minutes past the next hour, then run:

   ```powershell
   gh run list --repo theoithinkk/uptime-monitor --workflow probe-hulog.yml --limit 5
   ```

   Runs with the event `workflow_dispatch`, started at about minute 5, came from the Worker. Runs with `schedule` are GitHub's backup. `npx wrangler tail`, left open over minute 5, shows `Hulog probe started on GitHub Actions`, or GitHub's answer if it refused (401 for a wrong or expired token).

   To rotate the token before it expires, make a new one the same way, run `npx wrangler secret put GH_DISPATCH_TOKEN` again, then delete the old token on GitHub.

GitHub turns off scheduled workflows in a public repo after 60 days with no activity in the repo, and emails a warning first. Turn it back on with `gh workflow enable probe-hulog.yml --repo theoithinkk/uptime-monitor`. Until then Hulog shows as Stale.

`wrangler.toml` serves the page on the custom domain `status.theoith.ink` and turns workers.dev off. The workers.dev URL carries the account's subdomain, which Cloudflare builds from the login email. For your own copy, change the `routes` pattern to a domain in your Cloudflare account, or delete `routes` and set `workers_dev = true`.

## Design decisions

**D1, not KV.** KV's free plan allows 1,000 writes a day. This needs about 1,200: 600 probes a day, two writes each. KV also can't sum or sort, and it is eventually consistent, while the alert check reads back the rows it just wrote. D1 is SQLite, allows 100,000 writes a day for free, and can sort rows and bump counters in SQL.

**Daily rollups.** D1's free plan allows 5 million rows read a day. Working out 30-day SLOs from raw rows means reading about 18,000 rows on every page view, which allows only about 270 views a day. The `daily` table keeps one row per target per day, so a page view reads about 700 rows: 30 daily rows per target, plus 24 hours of raw rows for the p95, the latency chart and the burn rates. Each page query filters on the table's primary key prefix (`target`), so SQLite reads only the rows it needs and never scans the whole table.

**Hulog is probed hourly.** Hulog runs on Render's free tier, which sleeps after 15 idle minutes. A 5-minute probe would keep it awake all the time. That would use about 720 of the 750 free hours a month, and it would hide the cold start real users hit. Hourly probes mostly find it asleep, so Hulog's latency SLI is really a cold-start SLI. The Worker starts the run at minute 5, and GitHub's backup schedule is at minute 7, not 0, because GitHub starts on-the-hour jobs late, when most scheduled workflows fire at once. The 90 second timeout fits inside the job's 5 minute limit.

**Hulog is probed from GitHub Actions, not the Worker.** The bot check in front of onrender.com blocks every request from a Cloudflare Worker (details in [SLO.md](SLO.md)). Getting around it would mean pretending to be a browser or solving its challenge, and then the probe would measure something no real visitor does. GitHub's runners are outside Cloudflare, free for a public repo, and need nothing but curl.

**Push results to the Worker, don't make the Worker pull them.** The Worker can't reach Hulog, so the probe has to run somewhere else. The Worker starts that run, but it never fetches the result back: pulling it from GitHub's API would mean waiting for the run to finish and parsing its log. Pushing keeps one write path: the result goes through the same `record()` and `alertIfChanged()` as a cron probe, and the Worker stays the only thing that writes to D1. `/ingest` accepts only targets marked external in the code, so it can't add rows for any other target or make the Worker fetch anything.

**The Worker's clock, not the sender's.** The body has no timestamp field, and a body with one is refused. The row is stamped with `Date.now()` on the Worker when it arrives, at most about 90 seconds after the probe started. So whoever holds the token can't backdate a result into an old day, fill a gap or reorder history.

**At most one probe per target every 30 minutes.** If the token leaks, the worst anyone can add is one fake result every 30 minutes until I rotate it. Without the limit, a few seconds of fake failures would empty Hulog's whole budget of 7.2 failed probes. The check sits inside the same D1 batch as the insert, and a batch is one transaction, so requests sent at the same moment can't all pass the check before any of them writes. Locally, 10 parallel posts gave one 204 and nine 429s, and one row. The cost: when two runs land in the same half hour (the Worker's and the backup schedule's, or a late run and the next one), the second gets a 429. The workflow treats that as already recorded and ends green. At worst it is one missing data point, never a failure.

**Constant-time token check.** The sent token and the secret are both hashed with SHA-256, and the two digests are compared byte by byte without stopping at the first difference. The time taken then says nothing about how much of the token was right, and hashing first makes the lengths equal. Workers have `crypto.subtle.timingSafeEqual` but Node does not, and this way the tests run the same code as production.

**A bot check fails the run instead of recording a DOWN.** If GitHub's runners get challenged too, the probe would record a 429 that has nothing to do with Hulog, spend its error budget and page me for nothing. So the job sends nothing and fails. GitHub shows a red run, and after 3 hours with no probe the page shows Hulog as Stale. Missing data is honest; a false DOWN is not. Real failures (a timeout, a DNS error, a 5xx from Render) are still sent as failed probes.

**A Stale state.** GitHub can start scheduled runs late or skip them, the Worker's hourly start can be refused (an expired token), and GitHub turns off workflows in a repo with no activity for 60 days. None of that raises an error on the Worker. Without a Stale state, the page would show Hulog's last result as current for as long as the probes stay gone. 3 intervals leaves room for a late or skipped run before the badge changes. The same check covers the Cloudflare cron stopping.

**Alert after 2 failures in a row.** One failed probe is often a network blip. Paging on blips teaches you to ignore the pager. `FAILS_BEFORE_ALERT = 2` means DOWN fires on the second failure in a row, once per outage, and RECOVERED fires on the first success after it. The cost is slower detection: up to about 10 minutes for the sites and 2 hours for Hulog. The decision is a pure function, so the tests cover every transition.

**Shared fate, stated openly.** The Worker probes the two sites from Cloudflare, and both are hosted on Cloudflare. If Cloudflare goes down, those sites, this page and the alerts can all go down together. The status page footer says so. Hulog's probe now runs outside Cloudflare, but the Worker starts it and it still reports to the Worker. A Cloudflare outage stops the hourly start, and GitHub's backup schedule can still run, but its results are only recorded once the Worker answers again.

**Page hardening.** The page sends a CSP that allows no scripts at all, so even an injected tag can't run. Every value from the database is HTML-escaped. The page also sends `nosniff`, `no-referrer` and `frame-ancestors 'none'` against clickjacking. The targets and the GitHub dispatch URL are hardcoded, so no request can make the Worker fetch a URL of its choosing. The only write endpoint, `/ingest`, needs the token, checks every field and refuses anything else. The Telegram token, `INGEST_TOKEN` and `GH_DISPATCH_TOKEN` live only in secrets and are never logged. In the workflow, the token reaches curl on stdin, so it is not in any command line.

**Timing.** Workers freeze `Date.now()` while code runs and move it forward on I/O. Cloudflare does that to blunt Spectre-style timing attacks. It also means the measured time is network time to the response headers, not time spent in my code. On GitHub, curl's `time_starttransfer` measures the same thing: the time to the first byte of the response.

**Pure logic in its own file.** `slo.js` has no Worker APIs, so plain Node can test it with no extra dependencies. `index.js` only imports from it and exports nothing but the handlers, because workerd reads the main module's named exports as entry points and may reject anything else.

## Skipped, and when to add it

- **A probe from outside Cloudflare for the two Cloudflare sites.** Hulog is now probed from GitHub Actions, but the portfolio and the writeups are still only probed from Cloudflare, so their shared fate stands. A second GitHub probe for them would help, but it would still report to a Worker on Cloudflare. Breaking shared fate fully needs that job to alert on its own when the sites or the status page don't answer. Add it before I rely on this for anything that matters.
- **An alert when a service goes Stale.** The page shows Stale, but no Telegram message goes out when the GitHub probe stops. Add a check to the 5-minute cron that alerts once when an external target goes Stale, the first time the probe stops quietly for long. It would also catch an expired dispatch token.
- **Multi-window burn-rate alerts.** Add them once there is real traffic and a slow burn of the budget is worth catching early. With three small sites, 2 failures in a row is enough.
- **Content checks.** A 200 is not proof the right page loaded. A broken deploy or a parked domain can answer 200. Add a check for a known string in the page the first time that happens, or before the sites carry anything important.
- **Pruning.** About 600 rows a day is about 20 MB a year, against 500 MB per database on D1's free plan. Add a daily delete of raw probes older than 90 days when the database passes 250 MB. The daily rollups stay.
- **Re-sending a missed alert.** An alert fires only on the change of state. If Telegram is down at that moment, the alert is lost. Add an `alerts` table with a retry once that ever happens.
- **Project Sinag.** Add it as a fourth target with its own SLO once it goes live.
