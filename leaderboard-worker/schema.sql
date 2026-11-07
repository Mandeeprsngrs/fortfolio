-- Leaderboard storage (Cloudflare D1 = SQLite).
-- Run once:  npm run db:init:remote   (or db:init:local for `wrangler dev`)

-- Every accepted submission. The boards show each player's best (by initials).
CREATE TABLE IF NOT EXISTS scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game       TEXT    NOT NULL CHECK (game IN ('darts', 'maze')),
  name       TEXT    NOT NULL CHECK (length(name) = 3),
  score      INTEGER NOT NULL CHECK (score >= 0),
  ip_hash    TEXT    NOT NULL,              -- salted SHA-256 of the IP, for rate limiting only
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS scores_by_game  ON scores (game, score DESC);
CREATE INDEX IF NOT EXISTS scores_by_ip    ON scores (ip_hash, created_at);

-- The published boards: one row, rewritten by the 8-hourly cron.
-- GET /leaderboard reads only this, so visitors never scan `scores`.
CREATE TABLE IF NOT EXISTS snapshot (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT NOT NULL,                 -- JSON: { darts: [...], maze: [...] }
  updated_at TEXT NOT NULL
);
