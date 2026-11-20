-- 许愿瓶：D1 表结构
-- 见 docs/SERVER.md 第三节。修改这里时同步更新文档。

CREATE TABLE IF NOT EXISTS bottles (
  id            TEXT PRIMARY KEY,
  pool          TEXT NOT NULL,
  body          TEXT NOT NULL,
  author_token  TEXT NOT NULL,
  alias         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  picks         INTEGER NOT NULL DEFAULT 0,
  reply_id      TEXT,
  hidden        INTEGER NOT NULL DEFAULT 0,
  hidden_reason TEXT
);

CREATE TABLE IF NOT EXISTS replies (
  id           TEXT PRIMARY KEY,
  bottle_id    TEXT NOT NULL,
  body         TEXT NOT NULL,
  author_token TEXT NOT NULL,
  alias        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  hidden       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS picks (
  bottle_id    TEXT NOT NULL,
  picker_token TEXT NOT NULL,
  picked_at    INTEGER NOT NULL,
  PRIMARY KEY (bottle_id, picker_token)
);

CREATE TABLE IF NOT EXISTS reports (
  id         TEXT PRIMARY KEY,
  bottle_id  TEXT,
  reply_id   TEXT,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revoked_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  note       TEXT
);

CREATE INDEX IF NOT EXISTS idx_bottles_pool ON bottles(pool, expires_at, hidden);
CREATE INDEX IF NOT EXISTS idx_bottles_author ON bottles(author_token, created_at);
CREATE INDEX IF NOT EXISTS idx_picks_picker ON picks(picker_token, picked_at);
CREATE INDEX IF NOT EXISTS idx_replies_bottle ON replies(bottle_id);
