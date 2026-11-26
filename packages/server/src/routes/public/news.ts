// routes/public/news.ts - 新闻（海上的消息）+ 线索接收
//
// 明确不做的事：
//   - 前台 DTO 不返回 source_url（只给 source_name），避免导流与钓鱼
//   - 桌面端每天最多一条（news_seen 去重）
//   - 线索只能进入，**没有任何自动发布路径**（WINDOW 第五节）

import { NEWS_LEADS_PER_PUSH_MAX } from '@companion/contracts'
import { hashToken } from '../../crypto'
import type { ServerConfig } from '../../handler'
import { isOff } from '../../handler'
import { cacheHeaders, err, json } from '../../http/respond'
import { readJson } from '../../http/request'
import * as news from '../../repo/news'
import * as stats from '../../repo/stats'

const PAGE = 20

/** 前台 DTO：不含 sourceUrl / cover_key 之外的内部字段 */
function toDto(r: news.NewsRow) {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    body: r.body,
    category: r.category,
    sourceName: r.source_name,
    coverUrl: r.cover_key ? `/media/${encodeURIComponent(r.cover_key)}` : null,
    publishedAt: r.publish_at ?? r.created_at,
  }
}

export async function list(cfg: ServerConfig, url: URL, now: number): Promise<Response> {
  if (await isOff('NEWS_OFF', cfg)) return err('NEWS_OFF', 503)
  await news.publishDue(cfg.db, now).catch(() => 0) // 到期的定时稿顺手发布

  const after = Number(url.searchParams.get('cursor'))
  const rows = await news.listPublished(cfg.db, { after: Number.isFinite(after) && after > 0 ? after : null, limit: PAGE + 1 })
  const hasMore = rows.length > PAGE
  const page = hasMore ? rows.slice(0, PAGE) : rows
  return json(
    {
      ok: true,
      items: page.map(toDto),
      next: hasMore ? String(page[page.length - 1]!.publish_at) : null,
    },
    200,
    cacheHeaders(600),
  )
}

export async function detail(cfg: ServerConfig, id: string, now: number): Promise<Response> {
  if (await isOff('NEWS_OFF', cfg)) return err('NEWS_OFF', 503)
  const row = await news.findPublishedById(cfg.db, id)
  if (!row) return err('NOT_FOUND', 404)
  await stats.bump(cfg.db, stats.dayKey(now), 'news_views').catch(() => undefined)
  return json({ ok: true, item: toDto(row) }, 200, cacheHeaders(1800))
}

/** 桌面端每天取一条（设备令牌去重） */
export async function pick(_req: Request, cfg: ServerConfig, tokenHash: string, now: number): Promise<Response> {
  if (await isOff('NEWS_OFF', cfg)) return json({ ok: true, item: null }, 200, { 'Cache-Control': 'no-store' })

  const row = await news.pickUnseen(cfg.db, { deviceHash: tokenHash, since: now - 7 * 86400000, now })
  if (!row) return json({ ok: true, item: null }, 200, { 'Cache-Control': 'no-store' })

  await news.markSeen(cfg.db, tokenHash, row.id, now)
  return json({ ok: true, item: toDto(row) }, 200, { 'Cache-Control': 'no-store' })
}

/**
 * 爬虫推送线索。
 * 走独立的 NEWS_INGEST_TOKEN，**不复用管理员会话**：
 * 爬虫只能写线索，读取业务数据与发布新闻都需要人工。
 */
export async function handleIngest(req: Request, cfg: ServerConfig, now: number): Promise<Response> {
  if (req.method !== 'POST') return err('METHOD_NOT_ALLOWED', 405)
  if (!cfg.newsIngestToken) return err('NOT_FOUND', 404)

  const token = req.headers.get('X-Ingest-Token') ?? ''
  if (!token || token !== cfg.newsIngestToken) return err('ADMIN_UNAUTHORIZED', 401)

  const body = await readJson(req, 256 * 1024)
  if (!body.ok) return err('VALIDATION', 400)
  const leads = Array.isArray(body.value.leads) ? body.value.leads : []
  if (!leads.length || leads.length > NEWS_LEADS_PER_PUSH_MAX) return err('VALIDATION', 400)

  let added = 0
  for (const raw of leads) {
    if (!raw || typeof raw !== 'object') continue
    const l = raw as Record<string, unknown>
    const fingerprint = typeof l.fingerprint === 'string' ? l.fingerprint.slice(0, 200) : ''
    const id = typeof l.id === 'string' ? l.id.slice(0, 80) : ''
    if (!fingerprint || !id) continue
    const ok = await news.insertLead(cfg.db, {
      id,
      fingerprint,
      rawTitle: String(l.rawTitle ?? '').slice(0, 300),
      rawSummary: String(l.rawSummary ?? '').slice(0, 500),
      sourceName: String(l.sourceName ?? '').slice(0, 80),
      sourceUrl: String(l.sourceUrl ?? '').slice(0, 500),
      suggestedCategory: ['rain', 'night', 'city', 'cat', 'other'].includes(String(l.suggestedCategory))
        ? String(l.suggestedCategory)
        : 'other',
      fetchedAt: Number.isFinite(Number(l.fetchedAt)) ? Number(l.fetchedAt) : now,
      now,
    })
    if (ok) added++
  }

  return json({ ok: true, accepted: added, received: leads.length })
}
