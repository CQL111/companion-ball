-- 0005_stats - 聚合计数（概览页用）
--
-- 为什么单独一张表：D1 免费档读额度有限，概览每次刷新都跑全表聚合会很快耗尽。
-- 由 cron / 写入路径 +1，只存计数，**不含任何个体信息**。
-- 刻意不存 DAU / 停留时长 / PV——它们是社区指标，会诱导做社区的事（WINDOW 第十节）。

CREATE TABLE IF NOT EXISTS daily_stats (
  day              TEXT PRIMARY KEY,     -- YYYY-MM-DD（UTC）
  bottles_thrown   INTEGER NOT NULL DEFAULT 0,
  bottles_picked   INTEGER NOT NULL DEFAULT 0,
  replies_sent     INTEGER NOT NULL DEFAULT 0,
  reports_received INTEGER NOT NULL DEFAULT 0,
  gallery_views    INTEGER NOT NULL DEFAULT 0,
  news_views       INTEGER NOT NULL DEFAULT 0,
  download_clicks  INTEGER NOT NULL DEFAULT 0,
  downloads        INTEGER NOT NULL DEFAULT 0
);

-- 封海开关的状态与理由（值本身也可能写 KV 以求秒级生效，这里是对账与审计）
CREATE TABLE IF NOT EXISTS feature_flags (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL DEFAULT 0,
  reason     TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO feature_flags (key, value, reason, updated_at) VALUES
  ('EMERGENCY_OFF', 0, '', 0),
  ('GALLERY_OFF',   0, '', 0),
  ('NEWS_OFF',      0, '', 0),
  ('REPLY_OFF',     0, '', 0);
