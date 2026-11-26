// repo/reports.ts - 举报（值班队列的第二栏）
//
// 这是「管理员能看到私池内容」的**唯一窄缝**：举报人行使了「请人看」的权利。
// 只按举报记录精确查那一条，绝不提供「列出私池」的能力。

import type { Db } from '../db'

export interface ReportRow {
  id: string
  bottle_id: string | null
  reply_id: string | null
  reason: string
  created_at: number
  handled_at: number | null
  handled_by: string | null
  action: string | null
  snapshot_body: string | null
  snapshot_alias: string | null
}

export async function insert(
  db: Db,
  r: {
    id: string
    bottleId: string | null
    replyId: string | null
    reason: string
    now: number
    /** 举报时的内容快照：之后被隐藏/删除也能复核 */
    snapshotBody?: string | null
    snapshotAlias?: string | null
  },
): Promise<void> {
  await db
    .prepare('INSERT INTO reports (id, bottle_id, reply_id, reason, created_at, snapshot_body, snapshot_alias) VALUES (?,?,?,?,?,?,?)')
    .bind(r.id, r.bottleId, r.replyId, r.reason, r.now, r.snapshotBody ?? null, r.snapshotAlias ?? null)
    .run()
}

export async function listOpen(db: Db, limit: number): Promise<ReportRow[]> {
  const rows = await db
    .prepare('SELECT * FROM reports WHERE handled_at IS NULL ORDER BY created_at ASC LIMIT ?')
    .bind(limit)
    .all<ReportRow>()
  return rows.results ?? []
}

export async function findById(db: Db, id: string): Promise<ReportRow | null> {
  const row = await db.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first<ReportRow>()
  return row ?? null
}

export async function handle(
  db: Db,
  args: { id: string; action: 'hide' | 'keep'; by: string; now: number },
): Promise<boolean> {
  const r = await db
    .prepare('UPDATE reports SET handled_at = ?, handled_by = ?, action = ? WHERE id = ? AND handled_at IS NULL')
    .bind(args.now, args.by, args.action, args.id)
    .run()
  return r.changes > 0
}

export async function countOpen(db: Db): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM reports WHERE handled_at IS NULL').bind().first<{ n: number }>()
  return Number(row?.n ?? 0)
}

/** 最久的一条待处理举报有多久了（概览的红色告警线：> 2 小时） */
export async function oldestOpenAt(db: Db): Promise<number | null> {
  const row = await db
    .prepare('SELECT MIN(created_at) AS t FROM reports WHERE handled_at IS NULL')
    .bind()
    .first<{ t: number | null }>()
  return row?.t ?? null
}

export async function pruneHandled(db: Db, olderThan: number): Promise<number> {
  const r = await db.prepare('DELETE FROM reports WHERE handled_at IS NOT NULL AND handled_at < ?').bind(olderThan).run()
  return r.changes
}

/** 回信被举报时，后台需要看到的那一封（同样只按 id 精确查） */
export async function findReplyForReport(
  db: Db,
  replyId: string,
): Promise<{ id: string; body: string; alias: string; hidden: number } | null> {
  const row = await db
    .prepare('SELECT id, body, alias, hidden FROM replies WHERE id = ?')
    .bind(replyId)
    .first<{ id: string; body: string; alias: string; hidden: number }>()
  return row ?? null
}
