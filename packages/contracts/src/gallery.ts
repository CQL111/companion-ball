// gallery.ts - 橱窗（网页只读）契约
//
// 设计见 docs/WINDOW.md 第四、六节：
//   与私池完全分开的独立表；批准时快照；30 天自动下架；无互动、无独立 URL。
// 桌面端、服务端、网页、后台共用这一份类型。

import type { Pool } from './types'

/** 橱窗条目状态：单向流转，rejected / withdrawn 不可回到 pending */
export type GalleryStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn'

/** 给前台看的瓶子（**永不包含** seed / sourceBottle / 审核信息 / 时间） */
export interface GalleryItemDTO {
  id: string
  body: string
  alias: string
  pool: Pool
}

export interface GalleryPage {
  ok: true
  items: GalleryItemDTO[]
  /** 下一页游标；null = 没有更多（翻到底就是「今天海上只有这么多」） */
  next: string | null
}

export const GALLERY_PAGE_SIZE = 20
export const GALLERY_TTL_DAYS = 30
/** 橱窗正文上限：与私池同一套（60）——它本来就是私池的快照 */
export const GALLERY_BODY_MAX = 60

/** 前台举报橱窗条目时可选的原因 */
export const GALLERY_REPORT_REASONS = ['spam', 'abuse', 'other'] as const
export type GalleryReportReason = (typeof GALLERY_REPORT_REASONS)[number]

/** 后台看的橱窗条目（比 DTO 多出审核需要的字段） */
export interface GalleryAdminView extends GalleryItemDTO {
  status: GalleryStatus
  /** 1 = 官方种子（仅后台可见，前台永不暴露） */
  seed: boolean
  sourceBottle: string | null
  createdAt: number
  reviewedAt: number | null
  reviewNote: string | null
  expiresAt: number | null
}
