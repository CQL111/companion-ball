-- 0004_admin - 后台账号 / 会话 / 登录限流 / 审计 / 举报
--
-- 认证方案见 docs/PLATFORM.md 第六节：API Key（只存 SHA-256）+ TOTP（AES-GCM 加密）。
-- 登录限流用 D1 原子自增，不用 KV——KV 的读-改-写并发时可被绕过（BUILD-PLATFORM 第五节）。

CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  key_hash      TEXT NOT NULL,        -- SHA-256(API Key)；原文只在创建时展示一次
  totp_secret   TEXT NOT NULL,        -- AES-GCM(主密钥来自 secret)
  role          TEXT NOT NULL,        -- viewer | operator | admin
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_admin ON admin_sessions(admin_id, expires_at);

-- 登录尝试：window 是「15 分钟块」的序号，key 是 u:<username> 或 ip:<hash>
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  key      TEXT NOT NULL,
  window   INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,           -- 管理员 id（不是邮箱）
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);

-- 举报的新增列在 0006 单独处理（SQLite 的 ALTER TABLE 无 IF NOT EXISTS，
-- 由 migrate.ts 的容错处理保证可重复执行）
