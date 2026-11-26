-- 0003_news - 新闻（海上的消息）+ 外部线索
--
-- 新闻：官方编辑、每天最多一条、可下架。source_url 存库但前台不渲染成链接。
-- 线索：由独立爬虫系统推送（WINDOW 第五节）。没有任何自动发布路径。

CREATE TABLE IF NOT EXISTS news (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  body        TEXT NOT NULL,
  source_name TEXT,
  source_url  TEXT,                    -- 存，但前台永不渲染成 <a>
  category    TEXT NOT NULL,           -- rain | night | city | cat | other
  cover_key   TEXT,
  status      TEXT NOT NULL,           -- draft | scheduled | published | archived
  publish_at  INTEGER,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_news_list ON news(status, publish_at);

-- 每个设备看过哪条（每天 ≤1 条）
CREATE TABLE IF NOT EXISTS news_seen (
  device_hash TEXT NOT NULL,
  news_id     TEXT NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (device_hash, news_id)
);

CREATE INDEX IF NOT EXISTS idx_news_seen_device ON news_seen(device_hash, seen_at);

-- 外部线索（爬虫推送，等待编辑消化）
CREATE TABLE IF NOT EXISTS news_leads (
  id                 TEXT PRIMARY KEY,
  fingerprint        TEXT NOT NULL UNIQUE,   -- 幂等去重
  raw_title          TEXT NOT NULL,
  raw_summary        TEXT NOT NULL,
  source_name        TEXT NOT NULL,
  source_url         TEXT NOT NULL,
  suggested_category TEXT NOT NULL,
  fetched_at         INTEGER NOT NULL,
  status             TEXT NOT NULL,          -- new | used | ignored
  used_news_id       TEXT,
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON news_leads(status, fetched_at);
