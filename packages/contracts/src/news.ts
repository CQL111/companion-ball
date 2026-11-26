// news.ts - 新闻（海上的消息）与外部线索契约
//
// 设计见 docs/WINDOW.md 4.5 / 第五节。
// 两条硬规则写进类型：
//   1. 前台永不渲染外链（sourceUrl 存库，但 DTO 里只给 sourceName）
//   2. 线索只「发现」，**没有任何自动发布路径**——NewsLeadPush 里没有 status / publish 字段

export type NewsCategory = 'rain' | 'night' | 'city' | 'cat' | 'other'
export type NewsStatus = 'draft' | 'scheduled' | 'published' | 'archived'

export const NEWS_TITLE_MAX = 30
export const NEWS_SUMMARY_MAX = 60
export const NEWS_BODY_MAX = 200
export const NEWS_CATEGORIES: readonly NewsCategory[] = ['rain', 'night', 'city', 'cat', 'other']

/** 给前台看的新闻（不含 source_url、不含草稿） */
export interface NewsItemDTO {
  id: string
  title: string
  summary: string
  body: string
  category: NewsCategory
  /** 只给来源**名字**，前台不渲染成链接 */
  sourceName: string | null
  coverUrl: string | null
  publishedAt: number
}

export interface NewsListPage {
  ok: true
  items: NewsItemDTO[]
  next: string | null
}

/** 桌面端每天取一条的结果（没有新消息时 item = null） */
export interface NewsPickResult {
  ok: true
  item: NewsItemDTO | null
}

/** 后台编辑器读写的完整新闻 */
export interface NewsAdminView {
  id: string
  title: string
  summary: string
  body: string
  sourceName: string | null
  sourceUrl: string | null
  category: NewsCategory
  coverKey: string | null
  status: NewsStatus
  publishAt: number | null
  createdAt: number
  updatedAt: number | null
}

// ---------- 外部线索（爬虫系统 → 服务端）----------
//
// 爬虫是独立仓库/进程。它只认这里的类型；本仓库不实现它，也不给它发布能力。
// 走独立 service token（NEWS_INGEST_TOKEN），与管理员凭据分离。

export interface NewsLead {
  /** 爬虫侧生成的稳定 id（幂等键） */
  id: string
  rawTitle: string
  rawSummary: string
  sourceName: string
  sourceUrl: string
  suggestedCategory: NewsCategory
  fetchedAt: number
  /** 去重指纹（规范化标题 + 来源域），由爬虫保证稳定 */
  fingerprint: string
}

export interface NewsLeadPush {
  leads: NewsLead[]
}

export const NEWS_LEADS_PER_PUSH_MAX = 50

export type LeadStatus = 'new' | 'used' | 'ignored'

export interface NewsLeadAdminView extends NewsLead {
  status: LeadStatus
  /** 消化成了哪条新闻 */
  usedNewsId: string | null
  createdAt: number
}
