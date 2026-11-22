-- One row per probe. Kept raw so the last 24 hours can give a p95.
CREATE TABLE IF NOT EXISTS probes (
  target TEXT    NOT NULL,
  ts     INTEGER NOT NULL, -- unix ms when the probe started
  ok     INTEGER NOT NULL, -- 1 when the response was 2xx within the timeout
  status INTEGER,          -- HTTP status, NULL on timeout or network error
  ms     INTEGER NOT NULL, -- time to response headers
  err    TEXT,             -- short error, NULL when a response came back
  PRIMARY KEY (target, ts)
) WITHOUT ROWID;

-- One row per target per UTC day. The status page reads these for 30-day SLOs.
CREATE TABLE IF NOT EXISTS daily (
  target TEXT    NOT NULL,
  day    TEXT    NOT NULL, -- YYYY-MM-DD in UTC
  total  INTEGER NOT NULL, -- all probes
  good   INTEGER NOT NULL, -- probes that were ok
  fast   INTEGER NOT NULL, -- good AND ms <= the target's latency threshold
  PRIMARY KEY (target, day)
) WITHOUT ROWID;
