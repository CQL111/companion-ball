// repo/admins.ts - 后台账号 / 会话 / 登录限流 / 审计 / 开关

import type { Db } from '../db'

export interface AdminRow {
  id: string
  username: string
  key_hash: string
  totp_secret: string
  role: 'viewer' | 'operator' | 'admin'
  disabled: number
  created_at: number
  last_login_at: number | null
}

export async function findByUsername(db: Db, username: string): Promise<AdminRow | null> {
  const row = await db.prepare('SELECT * FROM admin_users WHERE username = ?').bind(username).first<AdminRow>()
  return row ?? null
}

export async function findById(db: Db, id: string): Promise<AdminRow | null> {
  const row = await db.prepare('SELECT * FROM admin_users WHERE id = ?').bind(id).first<AdminRow>()
  return row ?? null
}

export async function listAdmins(db: Db): Promise<AdminRow[]> {
  const rows = await db.prepare('SELECT * FROM admin_users ORDER BY created_at').bind().all<AdminRow>()
  return rows.results ?? []
}

export async function countAdmins(db: Db): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM admin_users').bind().first<{ n: number }>()
  return Number(row?.n ?? 0)
}

export async function insertAdmin(
  db: Db,
  a: { id: string; username: string; keyHash: string; totpSecret: string; role: string; now: number },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO admin_users (id, username, key_hash, totp_secret, role, disabled, created_at) VALUES (?,?,?,?,?,0,?)',
    )
    .bind(a.id, a.username, a.keyHash, a.totpSecret, a.role, a.now)
    .run()
}

export async function updateAdmin(
  db: Db,
  args: { id: string; role?: string; disabled?: boolean },
): Promise<boolean> {
  const sets: string[] = []
  const params: unknown[] = []
  if (args.role !== undefined) {
    sets.push('role = ?')
    params.push(args.role)
  }
  if (args.disabled !== undefined) {
    sets.push('disabled = ?')
    params.push(args.disabled ? 1 : 0)
  }
  if (!sets.length) return false
  const r = await db.prepare(`UPDATE admin_users SET ${sets.join(', ')} WHERE id = ?`).bind(...params, args.id).run()
  return r.changes > 0
}

export async function resetKeyHash(db: Db, id: string, keyHash: string, totpSecret?: string): Promise<boolean> {
  const r = totpSecret
    ? await db.prepare('UPDATE admin_users SET key_hash = ?, totp_secret = ? WHERE id = ?').bind(keyHash, totpSecret, id).run()
    : await db.prepare('UPDATE admin_users SET key_hash = ? WHERE id = ?').bind(keyHash, id).run()
  return r.changes > 0
}

export async function touchLogin(db: Db, id: string, now: number): Promise<void> {
  await db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').bind(now, id).run()
}

// ---------- 会话 ----------

export async function createSession(
  db: Db,
  s: { tokenHash: string; adminId: string; expiresAt: number; now: number },
): Promise<void> {
  await db
    .prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at, created_at) VALUES (?,?,?,?)')
    .bind(s.tokenHash, s.adminId, s.expiresAt, s.now)
    .run()
}

export async function findSession(db: Db, tokenHash: string, now: number): Promise<{ admin_id: string } | null> {
  const row = await db
    .prepare('SELECT admin_id FROM admin_sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, now)
    .first<{ admin_id: string }>()
  return row ?? null
}

export async function deleteSession(db: Db, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(tokenHash).run()
}

export async function pruneSessions(db: Db, now: number): Promise<number> {
  const r = await db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now).run()
  return r.changes
}

// ---------- 登录限流（D1 原子自增，不能用 KV）----------

/**
 * 计数并返回当前窗口内的尝试次数。
 * 一条 UPSERT 完成「读 + 加一」，并发下不会丢计数——
 * 这正是不能用 KV 的原因（KV 是读-改-写）。
 */
export async function bumpLoginAttempt(db: Db, key: string, window: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO admin_login_attempts (key, window, attempts) VALUES (?, ?, 1)
         ON CONFLICT(key, window) DO UPDATE SET attempts = attempts + 1
       RETURNING attempts`,
    )
    .bind(key, window)
    .first<{ attempts: number }>()
  return Number(row?.attempts ?? 1)
}

export async function getLoginAttempts(db: Db, key: string, window: number): Promise<number> {
  const row = await db
    .prepare('SELECT attempts FROM admin_login_attempts WHERE key = ? AND window = ?')
    .bind(key, window)
    .first<{ attempts: number }>()
  return Number(row?.attempts ?? 0)
}

/** 登录成功后清零，避免同窗口内被历史失败拖累 */
export async function clearLoginAttempts(db: Db, key: string, window: number): Promise<void> {
  await db.prepare('DELETE FROM admin_login_attempts WHERE key = ? AND window = ?').bind(key, window).run()
}

export async function pruneLoginAttempts(db: Db, olderThanWindow: number): Promise<number> {
  const r = await db.prepare('DELETE FROM admin_login_attempts WHERE window < ?').bind(olderThanWindow).run()
  return r.changes
}

// ---------- 审计（只追加）----------

export async function addAudit(
  db: Db,
  a: { id: string; actor: string; action: string; target: string | null; detail: string | null; now: number },
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (id, actor, action, target, detail, created_at) VALUES (?,?,?,?,?,?)')
    .bind(a.id, a.actor, a.action, a.target, a.detail, a.now)
    .run()
}

export interface AuditRow {
  id: string
  actor: string
  action: string
  target: string | null
  detail: string | null
  created_at: number
}

export async function listAudit(
  db: Db,
  args: { actor?: string; action?: string; limit: number },
): Promise<AuditRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (args.actor) {
    where.push('actor = ?')
    params.push(args.actor)
  }
  if (args.action) {
    where.push('action = ?')
    params.push(args.action)
  }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`
  const rows = await db.prepare(sql).bind(...params, args.limit).all<AuditRow>()
  return rows.results ?? []
}

// ---------- 封海开关 ----------

export interface FlagRow {
  key: string
  value: number
  reason: string
  updated_by: string | null
  updated_at: number
}

export async function listFlags(db: Db): Promise<FlagRow[]> {
  const rows = await db.prepare('SELECT * FROM feature_flags ORDER BY key').bind().all<FlagRow>()
  return rows.results ?? []
}

export async function getFlag(db: Db, key: string): Promise<boolean> {
  const row = await db.prepare('SELECT value FROM feature_flags WHERE key = ?').bind(key).first<{ value: number }>()
  return Number(row?.value ?? 0) === 1
}

/** 写开关必须带理由——审计里能看出「为什么关」 */
export async function setFlag(
  db: Db,
  args: { key: string; value: boolean; reason: string; by: string; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO feature_flags (key, value, reason, updated_by, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, reason = excluded.reason,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(args.key, args.value ? 1 : 0, args.reason.slice(0, 200), args.by, args.now)
    .run()
}
