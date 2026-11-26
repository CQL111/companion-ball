// repo/stats.ts - 聚合计数（只有计数器，不含任何个体信息）

import type { Db } from '../db'

export type StatField =
  | 'bottles_thrown'
  | 'bottles_picked'
  | 'replies_sent'
  | 'reports_received'
  | 'gallery_views'
  | 'news_views'
  | 'download_clicks'
  | 'downloads'

export function dayKey(now: number): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 计一次。字段名来自白名单，不能由外部输入拼接（防注入）。 */
export async function bump(db: Db, day: string, field: StatField): Promise<void> {
  await db
    .prepare(
      `INSERT INTO daily_stats (day, ${field}) VALUES (?, 1)
         ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + 1`,
    )
    .bind(day)
    .run()
}

export interface DayStats {
  day: string
  bottles_thrown: number
  bottles_picked: number
  replies_sent: number
  reports_received: number
  gallery_views: number
  news_views: number
  download_clicks: number
  downloads: number
}

export async function range(db: Db, fromDay: string, toDay: string): Promise<DayStats[]> {
  const rows = await db
    .prepare('SELECT * FROM daily_stats WHERE day >= ? AND day <= ? ORDER BY day')
    .bind(fromDay, toDay)
    .all<DayStats>()
  return rows.results ?? []
}

export interface Ratios {
  pickRate: number
  replyRate: number
  reportRate: number
}

/**
 * 三个核心比率（近 7 天）。
 * 被捡率 = 被捡次数 / 扔出次数；回信率 = 回信 / 被捡；举报率 = 举报 / 被捡。
 * 分母为 0 时返回 0（不返回 NaN，前端不显示「—」以外的假数字）。
 */
export function ratios(days: DayStats[]): Ratios {
  let thrown = 0
  let picked = 0
  let replies = 0
  let reports = 0
  for (const d of days) {
    thrown += d.bottles_thrown
    picked += d.bottles_picked
    replies += d.replies_sent
    reports += d.reports_received
  }
  return {
    pickRate: thrown ? Math.min(1, picked / thrown) : 0,
    replyRate: picked ? Math.min(1, replies / picked) : 0,
    reportRate: picked ? reports / picked : 0,
  }
}
