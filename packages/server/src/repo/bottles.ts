// repo/bottles.ts - 私池数据访问
//
// ⚠️ 隐私边界（docs/WINDOW.md 6.5）：
// **后台路由不允许调用本文件除 findByIdForReport 以外的任何函数。**
// 私池是「两个人的事」——管理员的任何页面都读不到它。
// 这条约束由 scripts/check-admin-privacy.js 机器守护。

import type { Db } from '../db'

export interface BottleRow {
  id: string
  pool: string
  body: string
  alias: string
  created_at: number
  expires_at: number
  picks: number
  reply_id: string | null
  hidden: number
  author_token: string
}

export interface PickCandidate {
  id: string
  body: string
  alias: string
}

export async function isTokenRevoked(db: Db, tokenHash: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS x FROM revoked_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first()
  return !!row
}

export async function countToday(db: Db, table: 'bottles' | 'replies', tokenHash: string, since: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE author_token = ? AND created_at >= ?`)
    .bind(tokenHash, since)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

export async function insertBottle(
  db: Db,
  b: { id: string; pool: string; body: string; tokenHash: string; alias: string; now: number; expiresAt: number },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO bottles (id, pool, body, author_token, alias, created_at, expires_at, picks, hidden) VALUES (?,?,?,?,?,?,?,0,0)',
    )
    .bind(b.id, b.pool, b.body, b.tokenHash, b.alias, b.now, b.expiresAt)
    .run()
}

/** 找一个自己没捡过、没被回过、未过期的候选瓶 */
export async function findPickCandidate(
  db: Db,
  args: { pool: string; now: number; maxPicks: number; tokenHash: string },
): Promise<PickCandidate | null> {
  const row = await db
    .prepare(
      `SELECT b.id, b.body, b.alias
         FROM bottles b
        WHERE b.pool = ? AND b.expires_at > ? AND b.hidden = 0 AND b.reply_id IS NULL
          AND b.picks < ? AND b.author_token <> ?
          AND NOT EXISTS (SELECT 1 FROM picks p WHERE p.bottle_id = b.id AND p.picker_token = ?)
        ORDER BY RANDOM() LIMIT 1`,
    )
    .bind(args.pool, args.now, args.maxPicks, args.tokenHash, args.tokenHash)
    .first<PickCandidate>()
  return row ?? null
}

/** 原子占位：只有仍可捡时才 +1。返回是否抢到。 */
export async function claimPick(db: Db, bottleId: string, maxPicks: number): Promise<boolean> {
  const r = await db
    .prepare('UPDATE bottles SET picks = picks + 1 WHERE id = ? AND picks < ? AND hidden = 0 AND reply_id IS NULL')
    .bind(bottleId, maxPicks)
    .run()
  return r.changes > 0
}

export async function recordPick(db: Db, bottleId: string, tokenHash: string, now: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO picks (bottle_id, picker_token, picked_at) VALUES (?,?,?)')
    .bind(bottleId, tokenHash, now)
    .run()
}

export async function hasPicked(db: Db, bottleId: string, tokenHash: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS x FROM picks WHERE bottle_id = ? AND picker_token = ?')
    .bind(bottleId, tokenHash)
    .first()
  return !!row
}

/** 原子占位回信：只有「还没人回」才认这一封。返回是否抢到。 */
export async function claimReply(db: Db, bottleId: string, replyId: string, tokenHash: string): Promise<boolean> {
  const r = await db
    .prepare('UPDATE bottles SET reply_id = ? WHERE id = ? AND reply_id IS NULL AND hidden = 0 AND author_token <> ?')
    .bind(replyId, bottleId, tokenHash)
    .run()
  return r.changes > 0
}

export async function findReplyState(
  db: Db,
  bottleId: string,
): Promise<{ author_token: string; reply_id: string | null; hidden: number } | null> {
  const row = await db
    .prepare('SELECT author_token, reply_id, hidden FROM bottles WHERE id = ?')
    .bind(bottleId)
    .first<{ author_token: string; reply_id: string | null; hidden: number }>()
  return row ?? null
}

export async function insertReply(
  db: Db,
  r: { id: string; bottleId: string; body: string; tokenHash: string; alias: string; now: number },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO replies (id, bottle_id, body, author_token, alias, created_at, hidden) VALUES (?,?,?,?,?,?,0)',
    )
    .bind(r.id, r.bottleId, r.body, r.tokenHash, r.alias, r.now)
    .run()
}

export interface InboxRow {
  bottleId: string
  bottleBody: string
  replyBody: string
  replyAlias: string
  createdAt: number
}

export async function listInbox(db: Db, tokenHash: string, limit = 20): Promise<InboxRow[]> {
  const rows = await db
    .prepare(
      `SELECT b.id AS bottleId, b.body AS bottleBody, r.body AS replyBody, r.alias AS replyAlias, r.created_at AS createdAt
         FROM bottles b JOIN replies r ON r.id = b.reply_id
        WHERE b.author_token = ? AND b.hidden = 0 AND r.hidden = 0
        ORDER BY r.created_at DESC LIMIT ?`,
    )
    .bind(tokenHash, limit)
    .all<InboxRow>()
  return rows.results ?? []
}

/** 举报前校验「确实见过」：捡过，或自己写的（防 IDOR） */
export async function hasSeenForReport(db: Db, bottleId: string, tokenHash: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM picks WHERE bottle_id = ? AND picker_token = ?
       UNION ALL SELECT 1 FROM bottles WHERE id = ? AND author_token = ?`,
    )
    .bind(bottleId, tokenHash, bottleId, tokenHash)
    .first()
  return !!row
}

export async function hideBottle(db: Db, bottleId: string, reason: string): Promise<void> {
  await db.prepare('UPDATE bottles SET hidden = 1, hidden_reason = ? WHERE id = ?').bind(reason, bottleId).run()
}

export async function hideReply(db: Db, replyId: string): Promise<void> {
  await db.prepare('UPDATE replies SET hidden = 1 WHERE id = ?').bind(replyId).run()
}

/**
 * 唯一的后台可读入口：按 id 精确查询一条被举报的瓶子。
 * 只返回审核需要的字段，**不返回 author_token / picks / 完整行**。
 */
export async function findByIdForReport(
  db: Db,
  bottleId: string,
): Promise<{ id: string; body: string; alias: string; hidden: number; created_at: number } | null> {
  const row = await db
    .prepare('SELECT id, body, alias, hidden, created_at FROM bottles WHERE id = ?')
    .bind(bottleId)
    .first<{ id: string; body: string; alias: string; hidden: number; created_at: number }>()
  return row ?? null
}

/** 封禁设备：吊销令牌（后台按哈希操作，看不到设备任何信息） */
export async function revokeToken(db: Db, tokenHash: string, note: string, now: number): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO revoked_tokens (token_hash, created_at, note) VALUES (?,?,?)')
    .bind(tokenHash, now, note)
    .run()
}

export async function unrevokeToken(db: Db, tokenHash: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM revoked_tokens WHERE token_hash = ?').bind(tokenHash).run()
  return r.changes > 0
}

/** 沉海：删除过期瓶子（cron 调用） */
export async function sinkExpired(db: Db, now: number): Promise<number> {
  const r = await db.prepare('DELETE FROM bottles WHERE expires_at <= ?').bind(now).run()
  return r.changes
}
