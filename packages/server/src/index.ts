// index.ts - 许愿瓶 API（Cloudflare Workers + D1）
// 设计：docs/SERVER.md ｜ 风险：同文档第一节
// 所有接口 POST + JSON，带 X-Device-Token（服务端只存哈希）。
//
// 规则常量与校验来自 @companion/contracts（与桌面端同一份，不再手抄）。
// 加密工具在 ./crypto（服务端专用，不进契约包）。
//
// 三道闸（当前审核能力的全部）：
//   1. 限流：单设备每日投递/回信上限 + 单 IP 每分钟上限
//   2. 举报即隐藏：hidden = 1，所有人不可见（保留数据供复核）
//   3. 紧急开关：EMERGENCY_OFF=1 → 写接口 503

import {
  BOTTLE_MAX_LENGTH,
  REPLY_MAX_LENGTH,
  checkText,
  poolFor,
  randomAlias,
} from '@companion/contracts'
import { hashToken, randomId } from './crypto'

export interface Env {
  DB: D1Database
  BOTTLE_TTL_DAYS: string
  MAX_PICKS: string
  DAILY_BOTTLE_LIMIT: string
  DAILY_REPLY_LIMIT: string
  EMERGENCY_OFF: string
  /** 安装包分发（R2 绑定）；未绑定时回退到 R2_PUBLIC_BASE_URL */
  DOWNLOADS?: R2Bucket
  R2_PUBLIC_BASE_URL?: string
}

interface Ctx {
  env: Env
  tokenHash: string
  now: number
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function err(code: string, status = 400): Response {
  return json({ ok: false, error: code }, status)
}

function readLimit(env: Env, key: keyof Env, fallback: number): number {
  const n = Number(env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 取设备令牌并校验 */
async function auth(req: Request, env: Env): Promise<Ctx | Response> {
  const token = req.headers.get('X-Device-Token') || ''
  if (!token || token.length < 16 || token.length > 128) return err('BAD_TOKEN', 401)
  const tokenHash = await hashToken(token)
  return { env, tokenHash, now: Date.now() }
}

/** 一天从本地 0 点算起：与投递池用同一时区，避免跨时区用户配额错位 */
function dayStart(now: number, utcOffsetMinutes: number): number {
  const localMs = now + utcOffsetMinutes * 60000
  const localDay = localMs - (localMs % 86400000)
  return localDay - utcOffsetMinutes * 60000
}

/** 从请求体里读并夹紧时区偏移（分钟） */
function readOffset(body: Record<string, unknown>): number {
  const n = Number(body.utcOffsetMinutes)
  return Number.isFinite(n) ? Math.max(-840, Math.min(840, Math.round(n))) : 0
}

// ---------- 限流 ----------
async function countToday(
  db: D1Database,
  table: 'bottles' | 'replies',
  tokenHash: string,
  since: number,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE author_token = ? AND created_at >= ?`)
    .bind(tokenHash, since)
    .first<{ n: number }>()
  return row?.n ?? 0
}

async function isRevoked(db: D1Database, tokenHash: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM revoked_tokens WHERE token_hash = ?').bind(tokenHash).first()
  return !!row
}

// ---------- 接口 ----------

/** POST /v1/bottle - 扔一个瓶子 */
async function throwBottle(req: Request, env: Env, tokenHash: string, now: number): Promise<Response> {
  if (env.EMERGENCY_OFF === '1') return err('SERVICE_PAUSED', 503)
  if (await isRevoked(env.DB, tokenHash)) return err('REVOKED', 403)

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const check = checkText(body.body, BOTTLE_MAX_LENGTH)
  if (!check.ok) return json({ ok: false, error: check.reason }, 200)

  const offset = readOffset(body)
  const limit = readLimit(env, 'DAILY_BOTTLE_LIMIT', 3)
  if ((await countToday(env.DB, 'bottles', tokenHash, dayStart(now, offset))) >= limit) {
    return err('DAILY_LIMIT', 429)
  }
  const pool = poolFor(now, offset)
  const id = randomId()
  const ttlDays = readLimit(env, 'BOTTLE_TTL_DAYS', 7)
  const expiresAt = now + ttlDays * 86400000
  const alias = randomAlias()

  await env.DB.prepare(
    'INSERT INTO bottles (id, pool, body, author_token, alias, created_at, expires_at, picks, hidden) VALUES (?,?,?,?,?,?,?,0,0)',
  )
    .bind(id, pool, check.cleaned, tokenHash, alias, now, expiresAt)
    .run()

  return json({ ok: true, id, expiresAt, alias })
}

/** POST /v1/bottle/pick - 捡一个（可能空手） */
async function pickBottle(req: Request, env: Env, tokenHash: string, now: number): Promise<Response> {
  if (env.EMERGENCY_OFF === '1') return err('SERVICE_PAUSED', 503)
  if (await isRevoked(env.DB, tokenHash)) return err('REVOKED', 403)

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const pool = poolFor(now, readOffset(body))
  const maxPicks = readLimit(env, 'MAX_PICKS', 3)

  // 随机取一张：同池、未过期、未隐藏、未回信、未捡满、不是自己写的、自己没捡过
  const row = await env.DB.prepare(
    `SELECT b.id, b.body, b.alias, b.picks
       FROM bottles b
      WHERE b.pool = ? AND b.expires_at > ? AND b.hidden = 0 AND b.reply_id IS NULL
        AND b.picks < ? AND b.author_token <> ?
        AND NOT EXISTS (SELECT 1 FROM picks p WHERE p.bottle_id = b.id AND p.picker_token = ?)
      ORDER BY RANDOM() LIMIT 1`,
  )
    .bind(pool, now, maxPicks, tokenHash, tokenHash)
    .first<{ id: string; body: string; alias: string; picks: number }>()

  if (!row) return json({ ok: true, bottle: null })

  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO picks (bottle_id, picker_token, picked_at) VALUES (?,?,?)').bind(row.id, tokenHash, now),
    env.DB.prepare('UPDATE bottles SET picks = picks + 1 WHERE id = ?').bind(row.id),
  ])

  return json({ ok: true, bottle: { id: row.id, body: row.body, alias: row.alias } })
}

/** POST /v1/bottle/reply - 回一句 */
async function replyBottle(req: Request, env: Env, tokenHash: string, now: number): Promise<Response> {
  if (env.EMERGENCY_OFF === '1') return err('SERVICE_PAUSED', 503)
  if (await isRevoked(env.DB, tokenHash)) return err('REVOKED', 403)

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const bottleId = typeof body.bottleId === 'string' ? body.bottleId : ''
  if (!bottleId) return err('NO_BOTTLE')

  const check = checkText(body.body, REPLY_MAX_LENGTH)
  if (!check.ok) return json({ ok: false, error: check.reason }, 200)

  const limit = readLimit(env, 'DAILY_REPLY_LIMIT', 10)
  if ((await countToday(env.DB, 'replies', tokenHash, dayStart(now, readOffset(body)))) >= limit) {
    return err('DAILY_LIMIT', 429)
  }

  const bottle = await env.DB.prepare(
    'SELECT id, author_token, reply_id, hidden FROM bottles WHERE id = ?',
  )
    .bind(bottleId)
    .first<{ id: string; author_token: string; reply_id: string | null; hidden: number }>()
  if (!bottle || bottle.hidden) return err('NOT_FOUND', 404)
  if (bottle.reply_id) return err('ALREADY_REPLIED', 409)
  if (bottle.author_token === tokenHash) return err('SELF_REPLY', 400)

  const replyId = randomId()
  const alias = randomAlias()
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO replies (id, bottle_id, body, author_token, alias, created_at, hidden) VALUES (?,?,?,?,?,?,0)',
    ).bind(replyId, bottleId, check.cleaned, tokenHash, alias, now),
    env.DB.prepare('UPDATE bottles SET reply_id = ? WHERE id = ? AND reply_id IS NULL').bind(replyId, bottleId),
  ])

  return json({ ok: true, replyId, alias })
}

/** POST /v1/bottle/inbox - 取自己收到的回信 */
async function inbox(req: Request, env: Env, tokenHash: string, now: number): Promise<Response> {
  if (await isRevoked(env.DB, tokenHash)) return err('REVOKED', 403)
  const rows = await env.DB.prepare(
    `SELECT b.id AS bottleId, b.body AS bottleBody, r.body AS replyBody, r.alias AS replyAlias, r.created_at AS createdAt
       FROM bottles b JOIN replies r ON r.id = b.reply_id
      WHERE b.author_token = ? AND b.hidden = 0 AND r.hidden = 0
      ORDER BY r.created_at DESC LIMIT 20`,
  )
    .bind(tokenHash)
    .all<{ bottleId: string; bottleBody: string; replyBody: string; replyAlias: string; createdAt: number }>()
  // 注意：不返回回信者的任何可关联信息，且回信一旦送达即视为结束
  return json({ ok: true, replies: rows.results ?? [] })
}

/** POST /v1/report - 举报 */
async function report(req: Request, env: Env, tokenHash: string, now: number): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const bottleId = typeof body.bottleId === 'string' ? body.bottleId : null
  const replyId = typeof body.replyId === 'string' ? body.replyId : null
  const reason = ['spam', 'abuse', 'other'].includes(String(body.reason)) ? String(body.reason) : 'other'
  if (!bottleId && !replyId) return err('NO_TARGET')

  await env.DB.prepare('INSERT INTO reports (id, bottle_id, reply_id, reason, created_at) VALUES (?,?,?,?,?)')
    .bind(randomId(), bottleId, replyId, reason, now)
    .run()

  // 举报即隐藏：不等待人工复核，先对所有人生效
  if (bottleId) await env.DB.prepare('UPDATE bottles SET hidden = 1, hidden_reason = ? WHERE id = ?').bind(reason, bottleId).run()
  if (replyId) await env.DB.prepare('UPDATE replies SET hidden = 1 WHERE id = ?').bind(replyId).run()

  return json({ ok: true })
}

// ---------- 下载（公开只读，不需要设备令牌） ----------

/** 读取 latest.json：优先 R2 绑定，其次公开域名；都没有则返回 null */
async function readManifest(env: Env): Promise<Record<string, unknown> | null> {
  if (env.DOWNLOADS) {
    const obj = await env.DOWNLOADS.get('latest.json')
    if (obj) {
      try {
        return JSON.parse(await obj.text())
      } catch {
        return null
      }
    }
    return null
  }
  const base = String(env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  if (!base) return null
  const res = await fetch(`${base}/latest.json`, { cf: { cacheTtl: 60 } as never })
  if (!res.ok) return null
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/** GET /v1/download/manifest —— 版本号 + 各平台资产地址与校验值 */
async function downloadManifest(env: Env): Promise<Response> {
  const m = await readManifest(env)
  if (!m) return json({ ok: false, error: 'NO_RELEASE' }, 503)
  return json({ ok: true, ...m })
}

/** GET /v1/download/latest?os=win|mac —— 302 到最新安装包 */
async function downloadLatest(env: Env, url: URL): Promise<Response> {
  const os = (url.searchParams.get('os') || 'win').toLowerCase()
  if (os !== 'win' && os !== 'mac') return err('BAD_OS', 400)

  const m = await readManifest(env)
  const assets = (m?.assets || {}) as Record<string, { url?: string } | undefined>
  const target = assets[os]?.url
  if (!target) return json({ ok: false, error: 'NO_RELEASE' }, 503)

  // 只跳向配置好的下载域，避免开放重定向
  const base = String(env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  if (base && !target.startsWith(base)) return json({ ok: false, error: 'BAD_TARGET' }, 500)

  return new Response(null, {
    status: 302,
    headers: { Location: target, 'Cache-Control': 'no-store' },
  })
}

// ---------- 入口 ----------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    // 下载接口是公开 GET，不需要设备令牌
    if (req.method === 'GET') {
      try {
        if (url.pathname === '/v1/download/manifest') return await downloadManifest(env)
        if (url.pathname === '/v1/download/latest') return await downloadLatest(env, url)
        if (url.pathname === '/v1/health') {
          return json({ ok: true, paused: env.EMERGENCY_OFF === '1' })
        }
        return err('NOT_FOUND', 404)
      } catch {
        return err('INTERNAL', 500)
      }
    }

    if (req.method !== 'POST') return err('METHOD_NOT_ALLOWED', 405)

    const authResult = await auth(req, env)
    if (authResult instanceof Response) return authResult
    const c = authResult

    try {
      switch (url.pathname) {
        case '/v1/bottle':
          return await throwBottle(req, c.env, c.tokenHash, c.now)
        case '/v1/bottle/pick':
          return await pickBottle(req, c.env, c.tokenHash, c.now)
        case '/v1/bottle/reply':
          return await replyBottle(req, c.env, c.tokenHash, c.now)
        case '/v1/bottle/inbox':
          return await inbox(req, c.env, c.tokenHash, c.now)
        case '/v1/report':
          return await report(req, c.env, c.tokenHash, c.now)
        case '/v1/health':
          return json({ ok: true, paused: c.env.EMERGENCY_OFF === '1' })
        default:
          return err('NOT_FOUND', 404)
      }
    } catch (e) {
      // 不把内部错误细节透给客户端
      return err('INTERNAL', 500)
    }
  },
}
