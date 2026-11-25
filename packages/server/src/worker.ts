// worker.ts - Cloudflare Workers 的薄适配层
// 业务逻辑全部在 ./handler；这里只负责把绑定转成 ServerConfig。
//
// 注意：workers.dev 子域在国内不可达，需要给 Worker 绑定自定义域名才可用。
// 这条路保留是为了「海外用户 / 将来换回 Cloudflare」时不用改业务代码。

import { d1Adapter, type RateCounter } from './db'
import { handleRequest, type ServerConfig } from './handler'

export interface Env {
  DB: D1Database
  RATE_LIMIT?: KVNamespace
  DOWNLOADS?: R2Bucket
  BOTTLE_TTL_DAYS: string
  MAX_PICKS: string
  DAILY_BOTTLE_LIMIT: string
  DAILY_REPLY_LIMIT: string
  IP_RATE_LIMIT_PER_MIN?: string
  PICK_PER_HOUR?: string
  INBOX_PER_HOUR?: string
  REPORT_PER_DAY?: string
  EMERGENCY_OFF: string
  R2_PUBLIC_BASE_URL?: string
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function kvRateCounter(kv: KVNamespace): RateCounter {
  return {
    async incr(key, ttlSeconds) {
      const raw = await kv.get(key)
      const next = (raw ? Number(raw) : 0) + 1
      await kv.put(key, String(next), { expirationTtl: Math.max(60, ttlSeconds) })
      return next
    },
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cfg: ServerConfig = {
      db: d1Adapter(env.DB),
      rate: env.RATE_LIMIT ? kvRateCounter(env.RATE_LIMIT) : undefined,
      downloadBaseUrl: env.R2_PUBLIC_BASE_URL || '',
      // Workers 前面一定有 Cloudflare，CF-Connecting-IP 由平台注入、不可伪造
      trustProxy: true,
      readManifestFromStore: env.DOWNLOADS
        ? async () => {
            const obj = await env.DOWNLOADS!.get('latest.json')
            if (!obj) return null
            return JSON.parse(await obj.text()) as Record<string, unknown>
          }
        : undefined,
      limits: {
        bottleTtlDays: num(env.BOTTLE_TTL_DAYS, 7),
        maxPicks: num(env.MAX_PICKS, 3),
        dailyBottleLimit: num(env.DAILY_BOTTLE_LIMIT, 3),
        dailyReplyLimit: num(env.DAILY_REPLY_LIMIT, 10),
        pickPerHour: num(env.PICK_PER_HOUR, 10),
        inboxPerHour: num(env.INBOX_PER_HOUR, 20),
        reportPerDay: num(env.REPORT_PER_DAY, 20),
        ipPerMinute: num(env.IP_RATE_LIMIT_PER_MIN, 30),
        emergencyOff: env.EMERGENCY_OFF === '1',
      },
    }
    return handleRequest(req, cfg)
  },
}
