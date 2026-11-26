// routes/public/gallery.ts - 橱窗（网页只读）
//
// 硬规则（WINDOW 4.3）：
//   - 只用 approved 且未过期的条目
//   - 不返回 seed / sourceBottle / 时间 / 任何计数
//   - 游标 = sort_key，不暴露总数
//   - noindex（页面层面)，接口不缓存个人化内容

import { GALLERY_PAGE_SIZE } from '@companion/contracts'
import type { ServerConfig } from '../../handler'
import { isOff } from '../../handler'
import { cacheHeaders, err, json } from '../../http/respond'
import * as gallery from '../../repo/gallery'
import * as stats from '../../repo/stats'

export async function list(cfg: ServerConfig, url: URL, now: number): Promise<Response> {
  if (await isOff('GALLERY_OFF', cfg)) return err('GALLERY_OFF', 503)

  const pool = ['night', 'morning', 'day', 'evening'].includes(String(url.searchParams.get('pool')))
    ? String(url.searchParams.get('pool'))
    : defaultPool(now)
  const cursorRaw = Number(url.searchParams.get('cursor'))
  const after = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null

  // 多取一条用来判断「还有没有下一页」
  const rows = await gallery.listPublic(cfg.db, { pool, now, afterSortKey: after, limit: GALLERY_PAGE_SIZE + 1 })
  const hasMore = rows.length > GALLERY_PAGE_SIZE
  const page = hasMore ? rows.slice(0, GALLERY_PAGE_SIZE) : rows

  return json(
    {
      ok: true,
      items: page.map((r) => ({ id: r.id, body: r.body, alias: r.alias, pool: r.pool })),
      next: hasMore ? String(page[page.length - 1]!.sort_key) : null,
    },
    200,
    cacheHeaders(300),
  )
}

/** 没有指定潮汐时，按访客本地时间给默认池——但服务端不知道访客时区，
 *  所以默认给「此刻 UTC 对应的块」，页面会在客户端再纠正一次。 */
function defaultPool(now: number): string {
  const h = new Date(now).getUTCHours()
  if (h >= 22 || h < 5) return 'night'
  if (h < 11) return 'morning'
  if (h < 18) return 'day'
  return 'evening'
}

/**
 * 浏览计数：只 +1，不记录任何个体信息。
 * 不做严格限流——这里多计几次只会让统计更保守，不会造成安全后果。
 */
export async function trackView(cfg: ServerConfig, now: number): Promise<Response> {
  try {
    await stats.bump(cfg.db, stats.dayKey(now), 'gallery_views')
  } catch {
    /* 统计失败不影响浏览 */
  }
  return json({ ok: true }, 200, { 'Cache-Control': 'no-store' })
}
