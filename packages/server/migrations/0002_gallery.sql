-- 0002_gallery - 橱窗（网页只读）
--
-- 与私池 bottles 完全分开：独立表、独立生命周期、独立审核状态。
-- 理由见 docs/PLATFORM.md 第四、六节与 docs/WINDOW.md 第四节。

CREATE TABLE IF NOT EXISTS gallery_bottles (
  id            TEXT PRIMARY KEY,
  source_bottle TEXT,                  -- 来源私池瓶 id；官方种子为 NULL
  pool          TEXT NOT NULL,         -- night | morning | day | evening
  body          TEXT NOT NULL,         -- 批准时的快照，不随私池变化
  alias         TEXT NOT NULL,
  status        TEXT NOT NULL,         -- pending | approved | rejected | withdrawn
  seed          INTEGER NOT NULL DEFAULT 0,  -- 1 = 官方种子（仅后台可见）
  sort_key      INTEGER NOT NULL,      -- 稳定随机排序种子
  reviewed_by   TEXT,
  reviewed_at   INTEGER,
  review_note   TEXT,                  -- 内部备注，前台永不展示
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER                -- approved + 30 天
);

CREATE INDEX IF NOT EXISTS idx_gallery_list ON gallery_bottles(status, pool, expires_at);
CREATE INDEX IF NOT EXISTS idx_gallery_source ON gallery_bottles(source_bottle);
CREATE INDEX IF NOT EXISTS idx_gallery_sort ON gallery_bottles(status, pool, sort_key);
