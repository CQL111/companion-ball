// repo/gallery.ts - 橱窗数据访问（与私池完全分开的表）
//
// 后台可读全部字段；前台只读 approved 的 DTO 投影（见 routes/public/gallery）。

import type { Db } from '../db'

export interface GalleryRow {
  id: string
  source_bottle: string | null
  pool: string
  body: string
  alias: string
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'
  seed: number
  sort_key: number
  reviewed_by: string | null
  reviewed_at: number | null
  review_note: string | null
  created_at: number
  expires_at: number | null
}

const COLS =
  'id, source_bottle, pool, body, alias, status, seed, sort_key, reviewed_by, reviewed_at, review_note, created_at, expires_at'

export async function insertPending(
  db: Db,
  g: { id: string; sourceBottle: string | null; pool: string; body: string; alias: string; seed?: boolean; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gallery_bottles (id, source_bottle, pool, body, alias, status, seed, sort_key, created_at)
       VALUES (?,?,?,?,?,'pending',?,?,?)`,
    )
    .bind(g.id, g.sourceBottle, g.pool, g.body, g.alias, g.seed ? 1 : 0, stableSortKey(g.id), g.now)
    .run()
}

/**
 * 稳定随机排序种子。
 * 不依赖 Math.random：同一 id 永远同一个位置，页面刷新不会跳动；
 * 不同 id 之间分布是散的，因此没有「第一屏霸权」。
 */
export function stableSortKey(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export async function findById(db: Db, id: string): Promise<GalleryRow | null> {
  const row = await db.prepare(`SELECT ${COLS} FROM gallery_bottles WHERE id = ?`).bind(id).first<GalleryRow>()
  return row ?? null
}

export async function review(
  db: Db,
  args: { id: string; status: 'approved' | 'rejected'; reviewer: string; note: string; now: number; ttlDays: number },
): Promise<boolean> {
  const expiresAt = args.status === 'approved' ? args.now + args.ttlDays * 86400000 : null
  const r = await db
    .prepare(
      `UPDATE gallery_bottles
          SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, expires_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .bind(args.status, args.reviewer, args.now, args.note.slice(0, 200), expiresAt, args.id)
    .run()
  return r.changes > 0
}

/** 下架（作者撤回或运营下架）。只对 approved 生效。 */
export async function withdraw(db: Db, id: string, reason: string, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE gallery_bottles SET status = 'withdrawn', review_note = ?, reviewed_at = ?
        WHERE id = ? AND status = 'approved'`,
    )
    .bind(reason.slice(0, 200), now, id)
    .run()
  return r.changes > 0
}

/** 作者在桌面端撤回 → 同步下架橱窗副本（快照独立，但必须联动） */
export async function withdrawBySourceBottle(db: Db, sourceBottleId: string, now: number): Promise<number> {
  const r = await db
    .prepare(
      `UPDATE gallery_bottles SET status = 'withdrawn', reviewed_at = ?
        WHERE source_bottle = ? AND status IN ('pending','approved')`,
    )
    .bind(now, sourceBottleId)
    .run()
  return r.changes
}

export async function listBySourceBottle(db: Db, sourceBottleId: string): Promise<GalleryRow | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM gallery_bottles WHERE source_bottle = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(sourceBottleId)
    .first<GalleryRow>()
  return row ?? null
}

// ---------- 前台读：只返回 approved 且未过期 ----------

export interface PublicGalleryRow {
  id: string
  body: string
  alias: string
  pool: string
  sort_key: number
}

/**
 * 潮汐分栏 + 游标翻页。
 * 游标就是上一页最后一条的 sort_key——不暴露总数，也不能跳到任意位置。
 */
export async function listPublic(
  db: Db,
  args: { pool: string; now: number; afterSortKey?: number | null; limit: number },
): Promise<PublicGalleryRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, body, alias, pool, sort_key
         FROM gallery_bottles
        WHERE status = 'approved' AND pool = ? AND (expires_at IS NULL OR expires_at > ?)
          AND sort_key > ?
        ORDER BY sort_key ASC
        LIMIT ?`,
    )
    .bind(args.pool, args.now, args.afterSortKey ?? 0, args.limit)
    .all<PublicGalleryRow>()
  return rows.results ?? []
}

export async function countApproved(db: Db, now: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM gallery_bottles WHERE status = 'approved' AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(now)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

// ---------- 后台列表 ----------

export async function listForAdmin(
  db: Db,
  args: { status?: string; pool?: string; limit: number },
): Promise<GalleryRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (args.status) {
    where.push('status = ?')
    params.push(args.status)
  }
  if (args.pool) {
    where.push('pool = ?')
    params.push(args.pool)
  }
  const sql = `SELECT ${COLS} FROM gallery_bottles ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`
  const rows = await db.prepare(sql).bind(...params, args.limit).all<GalleryRow>()
  return rows.results ?? []
}

export async function countByStatus(db: Db, status: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM gallery_bottles WHERE status = ?').bind(status).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

/** 种子占比：运营只靠这个数字防止「海是假的」 */
export async function seedShare(db: Db, now: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN seed = 1 THEN 1 ELSE 0 END) AS s, COUNT(*) AS t
         FROM gallery_bottles WHERE status = 'approved' AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(now)
    .first<{ s: number | null; t: number }>()
  const total = Number(row?.t ?? 0)
  if (!total) return 0
  return Number(row?.s ?? 0) / total
}

/** 过期下架（cron） */
export async function expireApproved(db: Db, now: number): Promise<number> {
  const r = await db
    .prepare(`UPDATE gallery_bottles SET status = 'withdrawn', review_note = 'expired' WHERE status = 'approved' AND expires_at <= ?`)
    .bind(now)
    .run()
  return r.changes
}
