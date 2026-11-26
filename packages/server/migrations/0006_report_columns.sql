-- 0006_report_columns - 举报的新增列（给值班队列用）
--
-- SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS。
-- migrate.ts 会把「duplicate column」当成已应用（幂等），
-- 这样新库一次过、老库补列，都不需要手工判断。

ALTER TABLE reports ADD COLUMN handled_at INTEGER;
ALTER TABLE reports ADD COLUMN handled_by TEXT;
ALTER TABLE reports ADD COLUMN action TEXT;
ALTER TABLE reports ADD COLUMN snapshot_body TEXT;
ALTER TABLE reports ADD COLUMN snapshot_alias TEXT;
