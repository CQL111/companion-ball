// handler.ts - 许愿瓶 API 的业务逻辑（平台无关）
//
// 输入 Request、输出 Response，只依赖 Web 标准（fetch / crypto.subtle）。
// Cloudflare Workers 与 Node 22 都能直接跑，不需要改业务代码。
//
// 设计：docs/SERVER.md ｜ 规则常量来自 @companion/contracts（与桌面端同一份）
//
// 三道闸：
//   1. 限流：设备日额度（Db 精确计数）+ 设备级速率 + IP 每分钟（粗粒度）
//   2. 举报即隐藏：hidden = 1，所有人不可见（保留数据供复核）
//   3. 紧急开关：EMERGENCY_OFF=1 → 所有写接口 503（含举报）

import {
  BOTTLE_MAX_LENGTH,
  REPLY_MAX_LENGTH,
  checkText,
  poolFor,
  randomAlias,
} from '@companion/contracts'
import { hashToken, randomId } from './crypto'
import type { Db, RateCounter } from './db'

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
    emergencyOff: boolean
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function err(code: string, status = 400): Response {
  return json({ ok: false, error: code }, status)
}

/** 一天从本地 0 点算起 */
function dayStart(now: number, utcOffsetMinutes: number): number {
  const localMs = now + utcOffsetMinutes * 60000
  const localDay = localMs - (localMs % 86400000)
  return localDay - utcOffsetMinutes * 60000
}

/**
 * 配额统计的起点。
 * 客户端自报时区是为了「今天」符合用户直觉，但**不能让它多拿额度**：
 * 取服务端当前日与客户端日里**更早**的那个，撒谎只会让窗口更大（额度更紧）。
 */
function quotaSince(now: number, clientOffset: number): number {
  return Math.min(dayStart(now, 0), dayStart(now, clientOffset))
}

function readOffset(body: Record<string, unknown>): number {
  const n = Number(body.utcOffsetMinutes)
  return Number.isFinite(n) ? Math.max(-840, Math.min(840, Math.round(n))) : 0
}

/** 规范 IP：取逗号前第一个、去掉端口、小写 */
function normalizeIp(raw: string | null): string | null {
  if (!raw) return null
  const first = raw.split(',')[0]?.trim() || ''
  if (!first) return null
  // IPv4:port / [IPv6]:port / 裸 IPv6
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(first)
  if (v4) return v4[1] ?? null
  const v6 = /^\[([0-9a-f:]+)\](?::\d+)?$/i.exec(first)
  if (v6) return (v6[1] ?? '').toLowerCase()
  return first.toLowerCase()
}

/**
 * 取可信的客户端 IP。
 * trustProxy=true 时才读反代/Cloudflare 写入的头；否则只认 socket 地址，
 * 避免客户端伪造 X-Real-IP / CF-Connecting-IP 绕过限流。
 */
function clientIp(req: Request, cfg: ServerConfig): string | null {
  if (cfg.trustProxy) {
    const fromHeader =
      req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')
    const normalized = normalizeIp(fromHeader)
    if (normalized) return normalized
  }
  return normalizeIp(cfg.socketIp ?? null)
}

async function countToday(db: Db, table: 'bottles' | 'replies', tokenHash: string, since: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE author_token = ? AND created_at >= ?`)
    .bind(tokenHash, since)
    .first<{ n: number }>()
  return row?.n ?? 0
}

async function isRevoked(db: Db, tokenHash: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM revoked_tokens WHERE token_hash = ?').bind(tokenHash).first()
  return !!row
}

/** 窗口计数：同一 key 在窗口内最多 limit 次 */
async function underRate(rate: RateCounter | undefined, key: string, windowSec: number, limit: number): Promise<boolean> {
  if (!rate) return true
  try {
    const used = await rate.incr(key, windowSec)
    return used <= limit
  } catch {
    return true // 计数故障不阻断业务
  }
}

async function checkIpLimit(req: Request, cfg: ServerConfig): Promise<Response | null> {
  const ip = clientIp(req, cfg)
  if (!ip) return null
  const ipHash = (await hashToken(ip)).slice(0, 16)
  const minute = Math.floor(Date.now() / 60000)
  const ok = await underRate(cfg.rate, `rl:${ipHash}:${minute}`, 120, cfg.limits.ipPerMinute)
  return ok ? null : err('RATE_LIMITED', 429)
}

// ---------- 接口 ----------

async function throwBottle(req: Request, cfg: ServerConfig, tokenHash: string, now: number): Promise<Response> {
  const { db, limits } = cfg
  if (await isRevoked(db, tokenHash)) return err('REVOKED', 403)

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const check = checkText(body.body, BOTTLE_MAX_LENGTH)
  if (!check.ok) return json({ ok: false, error: check.reason }, 200)

  const offset = readOffset(body)
  if ((await countToday(db, 'bottles', tokenHash, quotaSince(now, offset))) >= limits.dailyBottleLimit) {
    return err('DAILY_LIMIT', 429)
  }

  const id = randomId()
  const pool = poolFor(now, offset)
  const expiresAt = now + limits.bottleTtlDays * 86400000
  const alias = randomAlias()

  await db
    .prepare(
      'INSERT INTO bottles (id, pool, body, author_token, alias, created_at, expires_at, picks, hidden) VALUES (?,?,?,?,?,?,?,0,0)',
    )
    .bind(id, pool, check.cleaned, tokenHash, alias, now, expiresAt)
    .run()

  return json({ ok: true, id, expiresAt, alias })
}

/**
 * 捡瓶：先挑候选，再用条件 UPDATE 原子抢占（picks+1）。
 * 抢占失败（被别的请求抢先）就重试下一个候选，避免双发同一张。
 */
async function pickBottle(req: Request, cfg: ServerConfig, tokenHash: string, now: number): Promise<Response> {
  const { db, limits } = cfg
  if (await isRevoked(db, tokenHash)) return err('REVOKED', 403)

  const hour = Math.floor(now / 3600000)
  if (!(await underRate(cfg.rate, `pick:${tokenHash}:${hour}`, 3600, limits.pickPerHour))) {
    return err('RATE_LIMITED', 429)
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const pool = poolFor(now, readOffset(body))

  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db
      .prepare(
        `SELECT b.id, b.body, b.alias
           FROM bottles b
          WHERE b.pool = ? AND b.expires_at > ? AND b.hidden = 0 AND b.reply_id IS NULL
            AND b.picks < ? AND b.author_token <> ?
            AND NOT EXISTS (SELECT 1 FROM picks p WHERE p.bottle_id = b.id AND p.picker_token = ?)
          ORDER BY RANDOM() LIMIT 1`,
      )
      .bind(pool, now, limits.maxPicks, tokenHash, tokenHash)
      .first<{ id: string; body: string; alias: string }>()

    if (!row) return json({ ok: true, bottle: null })

    // 原子占位：只有仍可捡时才 +1
    const claimed = await db
      .prepare(
        `UPDATE bottles SET picks = picks + 1
          WHERE id = ? AND picks < ? AND hidden = 0 AND reply_id IS NULL`,
      )
      .bind(row.id, limits.maxPicks)
      .run()
    if (claimed.changes === 0) continue // 被抢走了，换一张

    await db
      .prepare('INSERT OR IGNORE INTO picks (bottle_id, picker_token, picked_at) VALUES (?,?,?)')
      .bind(row.id, tokenHash, now)
      .run()

    return json({ ok: true, bottle: { id: row.id, body: row.body, alias: row.alias } })
  }

  return json({ ok: true, bottle: null })
}

async function replyBottle(req: Request, cfg: ServerConfig, tokenHash: string, now: number): Promise<Response> {
  const { db, limits } = cfg
  if (await isRevoked(db, tokenHash)) return err('REVOKED', 403)

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const bottleId = typeof body.bottleId === 'string' ? body.bottleId : ''
  if (!bottleId) return err('NO_BOTTLE')

  const check = checkText(body.body, REPLY_MAX_LENGTH)
  if (!check.ok) return json({ ok: false, error: check.reason }, 200)

  if ((await countToday(db, 'replies', tokenHash, quotaSince(now, readOffset(body)))) >= limits.dailyReplyLimit) {
    return err('DAILY_LIMIT', 429)
  }

  // 只能回自己捡到过的瓶子（产品规则：捡到 → 看一眼 → 回一句 → 断）
  const picked = await db
    .prepare('SELECT 1 AS x FROM picks WHERE bottle_id = ? AND picker_token = ?')
    .bind(bottleId, tokenHash)
    .first()
  if (!picked) return err('NOT_FOUND', 404)

  const replyId = randomId()
  // 原子占位：只有「还没人回」的瓶子才认这一封
  const claimed = await db
    .prepare(
      `UPDATE bottles SET reply_id = ?
        WHERE id = ? AND reply_id IS NULL AND hidden = 0 AND author_token <> ?`,
    )
    .bind(replyId, bottleId, tokenHash)
    .run()

  if (claimed.changes === 0) {
    // 分清是「自己写的」还是「已被回」
    const bottle = await db
      .prepare('SELECT author_token, reply_id, hidden FROM bottles WHERE id = ?')
      .bind(bottleId)
      .first<{ author_token: string; reply_id: string | null; hidden: number }>()
    if (!bottle || bottle.hidden) return err('NOT_FOUND', 404)
    if (bottle.author_token === tokenHash) return err('SELF_REPLY', 400)
    return err('ALREADY_REPLIED', 409)
  }

  const alias = randomAlias()
  await db
    .prepare('INSERT INTO replies (id, bottle_id, body, author_token, alias, created_at, hidden) VALUES (?,?,?,?,?,?,0)')
    .bind(replyId, bottleId, check.cleaned, tokenHash, alias, now)
    .run()

  return json({ ok: true, replyId, alias })
}

async function inbox(_req: Request, cfg: ServerConfig, tokenHash: string, now: number): Promise<Response> {
  const { db, limits } = cfg
  if (await isRevoked(db, tokenHash)) return err('REVOKED', 403)

  const hour = Math.floor(now / 3600000)
  if (!(await underRate(cfg.rate, `inbox:${tokenHash}:${hour}`, 3600, limits.inboxPerHour))) {
    return err('RATE_LIMITED', 429)
  }

  const rows = await db
    .prepare(
      `SELECT b.id AS bottleId, b.body AS bottleBody, r.body AS replyBody, r.alias AS replyAlias, r.created_at AS createdAt
         FROM bottles b JOIN replies r ON r.id = b.reply_id
        WHERE b.author_token = ? AND b.hidden = 0 AND r.hidden = 0
        ORDER BY r.created_at DESC LIMIT 20`,
    )
    .bind(tokenHash)
    .all<{ bottleId: string; bottleBody: string; replyBody: string; replyAlias: string; createdAt: number }>()
  // 不返回回信者的任何可关联信息；回信一旦送达即视为结束
  return json({ ok: true, replies: rows.results ?? [] })
}

async function report(req: Request, cfg: ServerConfig, tokenHash: string, now: number): Promise<Response> {
  const { db, limits } = cfg

  const day = Math.floor(now / 86400000)
  if (!(await underRate(cfg.rate, `report:${tokenHash}:${day}`, 86400, limits.reportPerDay))) {
    return err('RATE_LIMITED', 429)
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const bottleId = typeof body.bottleId === 'string' ? body.bottleId.trim() : null
  const replyId = typeof body.replyId === 'string' ? body.replyId.trim() : null
  const reason = ['spam', 'abuse', 'other'].includes(String(body.reason)) ? String(body.reason) : 'other'
  if (!bottleId && !replyId) return err('NO_TARGET')

  // 只能举报**自己见过**的内容：否则任何人都能凭 id 下架别人的瓶子（IDOR）
  if (bottleId) {
    const seen = await db
      .prepare(
        `SELECT 1 AS x FROM picks WHERE bottle_id = ? AND picker_token = ?
         UNION ALL SELECT 1 FROM bottles WHERE id = ? AND author_token = ?`,
      )
      .bind(bottleId, tokenHash, bottleId, tokenHash)
      .first()
    if (!seen) return err('NOT_FOUND', 404)
  }

  await db
    .prepare('INSERT INTO reports (id, bottle_id, reply_id, reason, created_at) VALUES (?,?,?,?,?)')
    .bind(randomId(), bottleId, replyId, reason, now)
    .run()

  // 举报即隐藏：不等人工复核，先对所有人生效
  if (bottleId) {
    await db.prepare('UPDATE bottles SET hidden = 1, hidden_reason = ? WHERE id = ?').bind(reason, bottleId).run()
  }
  if (replyId) {
    await db.prepare('UPDATE replies SET hidden = 1 WHERE id = ?').bind(replyId).run()
  }

  return json({ ok: true })
}

// ---------- 下载（公开只读） ----------

async function readManifest(cfg: ServerConfig): Promise<Record<string, unknown> | null> {
  const base = String(cfg.downloadBaseUrl || '').replace(/\/+$/, '')
  if (base) {
    try {
      // 下游不可达时不把请求挂死
      const res = await fetch(`${base}/latest.json`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return (await res.json()) as Record<string, unknown>
    } catch {
      /* 落到存储分支 */
    }
  }
  if (cfg.readManifestFromStore) {
    try {
      return await cfg.readManifestFromStore()
    } catch {
      return null
    }
  }
  return null
}

async function downloadManifest(cfg: ServerConfig): Promise<Response> {
  const m = await readManifest(cfg)
  if (!m) return json({ ok: false, error: 'NO_RELEASE' }, 503)
  return json({ ok: true, ...m })
}

async function downloadLatest(cfg: ServerConfig, url: URL): Promise<Response> {
  const os = (url.searchParams.get('os') || 'win').toLowerCase()
  if (os !== 'win' && os !== 'mac') return err('BAD_OS', 400)

  const m = await readManifest(cfg)
  const assets = (m?.assets || {}) as Record<string, { url?: string } | undefined>
  const target = assets[os]?.url
  if (!target) return json({ ok: false, error: 'NO_RELEASE' }, 503)

  // 只跳向**同源**的下载域，前缀匹配挡不住 https://good.example.evil.com
  const base = String(cfg.downloadBaseUrl || '').replace(/\/+$/, '')
  if (base) {
    try {
      if (new URL(target).origin !== new URL(base).origin) {
        return json({ ok: false, error: 'BAD_TARGET' }, 500)
      }
    } catch {
      return json({ ok: false, error: 'BAD_TARGET' }, 500)
    }
  }

  return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } })
}

// ---------- 公开入口 ----------

export async function handleRequest(req: Request, cfg: ServerConfig): Promise<Response> {
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    return err('BAD_REQUEST', 400)
  }

  if (req.method === 'GET') {
    try {
      switch (url.pathname) {
        case '/v1/download/manifest':
          return await downloadManifest(cfg)
        case '/v1/download/latest':
          return await downloadLatest(cfg, url)
        case '/v1/health':
          return json({ ok: true, paused: cfg.limits.emergencyOff })
        default:
          return err('NOT_FOUND', 404)
      }
    } catch {
      return err('INTERNAL', 500)
    }
  }

  if (req.method !== 'POST') return err('METHOD_NOT_ALLOWED', 405)

  // 紧急开关：所有写接口（含举报）一律停
  if (cfg.limits.emergencyOff) return err('SERVICE_PAUSED', 503)

  const ipLimited = await checkIpLimit(req, cfg)
  if (ipLimited) return ipLimited

  const token = req.headers.get('X-Device-Token') || ''
  if (!token || token.length < 16 || token.length > 128 || token.includes(',')) {
    return err('BAD_TOKEN', 401)
  }

  const tokenHash = await hashToken(token)
  const now = Date.now()

  try {
    switch (url.pathname) {
      case '/v1/bottle':
        return await throwBottle(req, cfg, tokenHash, now)
      case '/v1/bottle/pick':
        return await pickBottle(req, cfg, tokenHash, now)
      case '/v1/bottle/reply':
        return await replyBottle(req, cfg, tokenHash, now)
      case '/v1/bottle/inbox':
        return await inbox(req, cfg, tokenHash, now)
      case '/v1/report':
        return await report(req, cfg, tokenHash, now)
      case '/v1/health':
        return json({ ok: true, paused: cfg.limits.emergencyOff })
      default:
        return err('NOT_FOUND', 404)
    }
  } catch (e) {
    // 抛给平台层记录日志（Node 的 createServer 会打印）；响应在那边统一转 500
    throw e
  }
}
