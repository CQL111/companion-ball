// repo/news.ts - 新闻 + 线索数据访问

import type { Db } from '../db'

export interface NewsRow {
  id: string
  title: string
  summary: string
  body: string
  source_name: string | null
  source_url: string | null
  category: string
  cover_key: string | null
  status: 'draft' | 'scheduled' | 'published' | 'archived'
  publish_at: number | null
  created_by: string | null
  created_at: number
  updated_at: number | null
}

const COLS =
  'id, title, summary, body, source_name, source_url, category, cover_key, status, publish_at, created_by, created_at, updated_at'

export interface DraftInput {
  id: string
  title: string
  summary: string
  body: string
  sourceName: string | null
  sourceUrl: string | null
  category: string
  coverKey: string | null
  createdBy: string
  now: number
}

export async function insertDraft(db: Db, d: DraftInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO news (id, title, summary, body, source_name, source_url, category, cover_key, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?)`,
    )
    .bind(d.id, d.title, d.summary, d.body, d.sourceName, d.sourceUrl, d.category, d.coverKey, d.createdBy, d.now, d.now)
    .run()
}

export async function updateDraft(
  db: Db,
  d: Omit<DraftInput, 'createdBy' | 'now'> & { now: number },
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE news SET title = ?, summary = ?, body = ?, source_name = ?, source_url = ?, category = ?, cover_key = ?, updated_at = ?
        WHERE id = ? AND status IN ('draft','scheduled')`,
    )
    .bind(d.title, d.summary, d.body, d.sourceName, d.sourceUrl, d.category, d.coverKey, d.now, d.id)
    .run()
  return r.changes > 0
}

export async function setPublish(
  db: Db,
  args: { id: string; status: 'published' | 'scheduled'; publishAt: number; now: number },
): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE news SET status = ?, publish_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft','scheduled')`)
    .bind(args.status, args.publishAt, args.now, args.id)
    .run()
  return r.changes > 0
}

/** 把到期的 scheduled 转成 published（cron / 读接口顺手触发） */
export async function publishDue(db: Db, now: number): Promise<number> {
  const r = await db
    .prepare(`UPDATE news SET status = 'published' WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= ?`)
    .bind(now)
    .run()
  return r.changes
}

export async function archive(db: Db, id: string, now: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE news SET status = 'archived', updated_at = ? WHERE id = ? AND status IN ('published','scheduled')`)
    .bind(now, id)
    .run()
  return r.changes > 0
}

export async function findById(db: Db, id: string): Promise<NewsRow | null> {
  const row = await db.prepare(`SELECT ${COLS} FROM news WHERE id = ?`).bind(id).first<NewsRow>()
  return row ?? null
}

/** 前台：已发布，按发布时间倒序，游标 = publish_at */
export async function listPublished(db: Db, args: { after?: number | null; limit: number }): Promise<NewsRow[]> {
  const rows = await db
    .prepare(
      `SELECT ${COLS} FROM news
        WHERE status = 'published' AND publish_at IS NOT NULL AND (? IS NULL OR publish_at < ?)
        ORDER BY publish_at DESC LIMIT ?`,
    )
    .bind(args.after ?? null, args.after ?? 0, args.limit)
    .all<NewsRow>()
  return rows.results ?? []
}

/** 前台：指定日期已发布的那条（每天最多一条） */
export async function findPublishedById(db: Db, id: string): Promise<NewsRow | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM news WHERE id = ? AND status = 'published' AND publish_at IS NOT NULL`)
    .bind(id)
    .first<NewsRow>()
  return row ?? null
}

export async function countPublishedToday(db: Db, dayStart: number, dayEnd: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM news WHERE status = 'published' AND publish_at >= ? AND publish_at < ?`)
    .bind(dayStart, dayEnd)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

export async function listForAdmin(db: Db, args: { status?: string; limit: number }): Promise<NewsRow[]> {
  if (args.status) {
    const rows = await db
      .prepare(`SELECT ${COLS} FROM news WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(args.status, args.limit)
      .all<NewsRow>()
    return rows.results ?? []
  }
  const rows = await db.prepare(`SELECT ${COLS} FROM news ORDER BY created_at DESC LIMIT ?`).bind(args.limit).all<NewsRow>()
  return rows.results ?? []
}

// ---------- 桌面端每天一条 ----------

/**
 * 挑一条该设备没看过的已发布新闻。
 * 优先「最近 7 天内发布」的；都看过了就返回 null（允许今天没有）。
 */
export async function pickUnseen(
  db: Db,
  args: { deviceHash: string; since: number; now: number },
): Promise<NewsRow | null> {
  const today = new Date(args.now)
  const dayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  // 今天已经取过 → 不再给第二条
  const seenToday = await db
    .prepare('SELECT 1 AS x FROM news_seen WHERE device_hash = ? AND seen_at >= ? LIMIT 1')
    .bind(args.deviceHash, dayStart)
    .first()
  if (seenToday) return null

  const row = await db
    .prepare(
      `SELECT ${COLS} FROM news
        WHERE status = 'published' AND publish_at IS NOT NULL AND publish_at >= ?
          AND id NOT IN (SELECT news_id FROM news_seen WHERE device_hash = ?)
        ORDER BY publish_at DESC LIMIT 1`,
    )
    .bind(args.since, args.deviceHash)
    .first<NewsRow>()
  return row ?? null
}

export async function markSeen(db: Db, deviceHash: string, newsId: string, now: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO news_seen (device_hash, news_id, seen_at) VALUES (?,?,?)')
    .bind(deviceHash, newsId, now)
    .run()
}

// ---------- 线索（爬虫推送）----------

export interface LeadInput {
  id: string
  rawTitle: string
  rawSummary: string
  sourceName: string
  sourceUrl: string
  suggestedCategory: string
  fetchedAt: number
  fingerprint: string
  now: number
}

/** 按 fingerprint 幂等插入。返回是否真的新增。 */
export async function insertLead(db: Db, l: LeadInput): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO news_leads
        (id, fingerprint, raw_title, raw_summary, source_name, source_url, suggested_category, fetched_at, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,'new',?)`,
    )
    .bind(l.id, l.fingerprint, l.rawTitle, l.rawSummary, l.sourceName, l.sourceUrl, l.suggestedCategory, l.fetchedAt, l.now)
    .run()
  return r.changes > 0
}

export interface LeadRow {
  id: string
  fingerprint: string
  raw_title: string
  raw_summary: string
  source_name: string
  source_url: string
  suggested_category: string
  fetched_at: number
  status: 'new' | 'used' | 'ignored'
  used_news_id: string | null
  created_at: number
}

export async function listLeads(db: Db, args: { status?: string; limit: number }): Promise<LeadRow[]> {
  if (args.status) {
    const rows = await db
      .prepare('SELECT * FROM news_leads WHERE status = ? ORDER BY fetched_at DESC LIMIT ?')
      .bind(args.status, args.limit)
      .all<LeadRow>()
    return rows.results ?? []
  }
  const rows = await db.prepare('SELECT * FROM news_leads ORDER BY fetched_at DESC LIMIT ?').bind(args.limit).all<LeadRow>()
  return rows.results ?? []
}

export async function markLead(
  db: Db,
  args: { id: string; status: 'used' | 'ignored'; usedNewsId?: string | null },
): Promise<boolean> {
  const r = await db
    .prepare('UPDATE news_leads SET status = ?, used_news_id = ? WHERE id = ? AND status = ?')
    .bind(args.status, args.usedNewsId ?? null, args.id, 'new')
    .run()
  return r.changes > 0
}

export async function pruneLeads(db: Db, olderThan: number): Promise<number> {
  const r = await db.prepare('DELETE FROM news_leads WHERE created_at < ?').bind(olderThan).run()
  return r.changes
}
