// handler.ts - 请求分派（平台无关，Workers 与 Node 共用）
//
// 输入 Request、输出 Response，只依赖 Web 标准。
// 业务逻辑按域拆在 routes/ 下；所有 SQL 在 repo/ 下。
//
// 三道闸（保留自 0.9.x）：
//   1. 限流：设备日额度 + 设备级速率 + IP 每分钟
//   2. 举报即隐藏
//   3. 紧急开关（所有写接口 503）

import { hashToken } from './crypto'
import type { Db, RateCounter } from './db'
import { normalizeIp } from './http/ip'
import { err, json } from './http/respond'
import * as bottleRoutes from './routes/public/bottle'
import * as downloadRoutes from './routes/public/download'
import * as galleryRoutes from './routes/public/gallery'
import * as metaRoutes from './routes/public/meta'
import * as newsRoutes from './routes/public/news'
import * as newsPage from './routes/public/newsPage'
import * as adminRoutes from './routes/admin/index'
import * as flags from './repo/admins'

export interface ServerConfig {
  db: Db
  rate?: RateCounter
  /** 下载清单的公开域名（R2 / 自建静态站） */
  downloadBaseUrl?: string
  readManifestFromStore?: () => Promise<Record<string, unknown> | null>
  /**
   * 是否信任反代写入的真实 IP 头。
   * false（默认）= 只认 socket 给的地址，客户端自带的头一律不信。
   */
  trustProxy: boolean
  /** Node 运行时由 socket 得到的对端地址 */
  socketIp?: string
  /** 后台 Cookie 的期望 Origin（同源部署下即站点域名） */
  siteOrigin?: string
  /** 对外展示的站点地址（meta 里给桌面端跳转用）；默认 boringtime.cn */
  siteUrl?: string
  /**
   * 内测模式：捡瓶时**忽略时段池**。
   * 只给「2 个人、分时段上线」的场景用，正式运营必须为 false。
   */
  intraTest?: boolean
  /** TOTP 主密钥（base64，来自 secret） */
  totpMasterKey?: string
  /** 爬虫推送线索的 service token */
  newsIngestToken?: string
  /** 静态资源绑定（有则 `/` 与 `/admin` 交给它） */
  assets?: { fetch(req: Request): Promise<Response> }
  limits: {
    bottleTtlDays: number
    maxPicks: number
    dailyBottleLimit: number
    dailyReplyLimit: number
    /** 单设备速率（文档承诺值） */
    pickPerHour: number
    inboxPerHour: number
    reportPerDay: number
    /** 单 IP 每分钟写请求上限 */
    ipPerMinute: number
    /** 兼容旧 env：EMERGENCY_OFF。真实值优先读 feature_flags 表 */
    emergencyOff: boolean
  }
}

// ---------- 共享工具（路由会用到）----------

/** 一天从本地 0 点算起 */
export function dayStart(now: number, utcOffsetMinutes: number): number {
  const localMs = now + utcOffsetMinutes * 60000
  const localDay = localMs - (localMs % 86400000)
  return localDay - utcOffsetMinutes * 60000
}

/**
 * 配额统计的起点。
 * 客户端自报时区是为了「今天」符合用户直觉，但**不能让它多拿额度**：
 * 取服务端当前日与客户端日里**更早**的那个，撒谎只会让窗口更大（额度更紧）。
 */
export function quotaSince(now: number, clientOffset: number): number {
  return Math.min(dayStart(now, 0), dayStart(now, clientOffset))
}

export function readOffset(body: Record<string, unknown>): number {
  const n = Number(body.utcOffsetMinutes)
  return Number.isFinite(n) ? Math.max(-840, Math.min(840, Math.round(n))) : 0
}

/** 取可信的客户端 IP（trustProxy 时才读反代头） */
export function clientIp(req: Request, cfg: ServerConfig): string | null {
  if (cfg.trustProxy) {
    const fromHeader = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')
    const normalized = normalizeIp(fromHeader)
    if (normalized) return normalized
  }
  return normalizeIp(cfg.socketIp ?? null)
}

/** 窗口计数：同一 key 在窗口内最多 limit 次 */
export async function underRate(rate: RateCounter | undefined, key: string, windowSec: number, limit: number): Promise<boolean> {
  if (!rate) return true
  try {
    const used = await rate.incr(key, windowSec)
    return used <= limit
  } catch {
    return true // 计数故障不阻断业务
  }
}

export async function checkIpLimit(req: Request, cfg: ServerConfig): Promise<Response | null> {
  const ip = clientIp(req, cfg)
  if (!ip) return null
  const ipHash = (await hashToken(ip)).slice(0, 16)
  const minute = Math.floor(Date.now() / 60000)
  const ok = await underRate(cfg.rate, `rl:${ipHash}:${minute}`, 120, cfg.limits.ipPerMinute)
  return ok ? null : err('RATE_LIMITED', 429)
}

/** 封海开关：优先读表，读不到时退回 env 的 emergencyOff */
export async function isOff(flag: string, cfg: ServerConfig): Promise<boolean> {
  try {
    if (flag === 'EMERGENCY_OFF' && cfg.limits.emergencyOff) return true
    return await flags.getFlag(cfg.db, flag)
  } catch {
    return flag === 'EMERGENCY_OFF' ? cfg.limits.emergencyOff : false
  }
}

/** 把某个静态页交给 assets 取（路径改写后请求同一个 assets） */
async function staticPage(cfg: ServerConfig, req: Request, assetPath: string): Promise<Response> {
  if (!cfg.assets) return err('NOT_FOUND', 404)
  const u = new URL(req.url)
  return cfg.assets.fetch(new Request(new URL(assetPath, u.origin).toString(), { method: 'GET', headers: req.headers }))
}

// ---------- 公开入口 ----------

export async function handleRequest(req: Request, cfg: ServerConfig): Promise<Response> {
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    return err('BAD_REQUEST', 400)
  }
  const now = Date.now()
  const path = url.pathname

  try {
    // ---------- 后台 API：不走设备令牌，走会话 Cookie ----------
    if (path.startsWith('/admin/api/')) {
      return await adminRoutes.handle(req, url, cfg, now)
    }

    // ---------- 内部接口：爬虫推送线索（独立 service token）----------
    if (path === '/v1/internal/news/leads') {
      return await newsRoutes.handleIngest(req, cfg, now)
    }

    // ---------- GET：公开只读 ----------
    if (req.method === 'GET') {
      switch (path) {
        case '/v1/download/manifest':
          return await downloadRoutes.manifest(cfg)
        case '/v1/download/latest':
          return await downloadRoutes.latest(cfg, url)
        case '/v1/gallery':
          return await galleryRoutes.list(cfg, url, now)
        case '/v1/news':
          return await newsRoutes.list(cfg, url, now)
        case '/v1/meta':
          return await metaRoutes.meta(cfg, now)
        case '/v1/health':
          return json({ ok: true, paused: await isOff('EMERGENCY_OFF', cfg) })
        // 页面：默认交给静态资源，只有 /news 与 /news/:id 服务端渲染
        case '/news':
          return await newsPage.renderList(cfg, now)
        case '/gallery':
          return await staticPage(cfg, req, '/gallery.html')
        case '/download':
          return await staticPage(cfg, req, '/download.html')
        case '/privacy':
          return await staticPage(cfg, req, '/privacy.html')
        case '/terms':
          return await staticPage(cfg, req, '/terms.html')
        default:
          break
      }
      // /v1/news/:id（JSON）
      const newsId = /^\/v1\/news\/([A-Za-z0-9_-]{1,64})$/.exec(path)
      if (newsId) return await newsRoutes.detail(cfg, newsId[1]!, now)
      // /news/:id（HTML，SEO）
      const newsPageId = /^\/news\/([A-Za-z0-9_-]{1,64})$/.exec(path)
      if (newsPageId) return await newsPage.renderDetail(cfg, newsPageId[1]!, now)
    }

    // ---------- 其余静态资源交给 assets（首页 / 下载 / 法务 / admin SPA）----------
    if (req.method === 'GET' && cfg.assets) {
      return await cfg.assets.fetch(req)
    }

    if (req.method !== 'POST') return err('METHOD_NOT_ALLOWED', 405)

    // ---------- POST：写接口 ----------

    // 紧急开关：所有用户写接口一律停（含举报）
    if (await isOff('EMERGENCY_OFF', cfg)) return err('SERVICE_PAUSED', 503)

    // 公开浏览的轻量计数：无需设备令牌
    if (path === '/v1/gallery/view') {
      return await galleryRoutes.trackView(cfg, now)
    }

    const ipLimited = await checkIpLimit(req, cfg)
    if (ipLimited) return ipLimited

    const token = req.headers.get('X-Device-Token') || ''
    if (!token || token.length < 16 || token.length > 128 || token.includes(',')) {
      return err('BAD_TOKEN', 401)
    }
    const tokenHash = await hashToken(token)

    switch (path) {
      case '/v1/bottle':
        return await bottleRoutes.throwBottle(req, cfg, tokenHash, now)
      case '/v1/bottle/pick':
        return await bottleRoutes.pick(req, cfg, tokenHash, now)
      case '/v1/bottle/reply':
        return await bottleRoutes.reply(req, cfg, tokenHash, now)
      case '/v1/bottle/inbox':
        return await bottleRoutes.inbox(req, cfg, tokenHash, now)
      case '/v1/report':
        return await bottleRoutes.report(req, cfg, tokenHash, now)
      case '/v1/news/pick':
        return await newsRoutes.pick(req, cfg, tokenHash, now)
      case '/v1/health':
        return json({ ok: true, paused: true })
      default:
        return err('NOT_FOUND', 404)
    }
  } catch (e) {
    // 抛给平台层记录日志（Node 的 createServer 会打印）；响应在那边统一转 500
    throw e
  }
}
