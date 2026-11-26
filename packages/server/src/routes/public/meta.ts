// routes/public/meta.ts - 协议版本 / 公告 / 开关状态
//
// 桌面端用它在开门前判断「能不能用」，避免在关闭状态下产生无意义的请求。

import type { ServerConfig } from '../../handler'
import { isOff } from '../../handler'
import { cacheHeaders, json } from '../../http/respond'

/** 协议版本：桌面端 ≥ 此版本才允许联网。改契约时 +1。 */
export const PROTOCOL_VERSION = 4

export async function meta(cfg: ServerConfig, now: number): Promise<Response> {
  const [paused, gallery, newsOff] = await Promise.all([
    isOff('EMERGENCY_OFF', cfg),
    isOff('GALLERY_OFF', cfg),
    isOff('NEWS_OFF', cfg),
  ])
  return json(
    {
      ok: true,
      protocol: PROTOCOL_VERSION,
      paused,
      features: { bottle: !paused, gallery: !gallery, news: !newsOff },
      /** 公告：空字符串表示没有 */
      notice: '',
      /** 站点地址（桌面端做「看看此刻的海」的跳转用） */
      site: cfg.siteUrl || 'https://boringtime.cn',
      now,
    },
    200,
    cacheHeaders(60),
  )
}
