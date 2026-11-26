// routes/admin/index.ts - 后台 API（灯塔）
//
// 隐私红线（WINDOW 6.5）：
//   本目录**只允许**通过 repo/bottles 的 findByIdForReport / hideBottle 触达私池——
//   前者只按 id 精确查一条（被举报的内容），后者是封禁动作。
//   不提供任何「列出私池」的能力。scripts/check-admin-privacy.js 会扫这里。

import { FLAG_KEYS, NEWS_BODY_MAX, NEWS_SUMMARY_MAX, NEWS_TITLE_MAX } from '@companion/contracts'
import { hashSecret, openSecret, randomId, randomSecret, sealSecret } from '../../crypto'
import type { ServerConfig } from '../../handler'
import type { Db } from '../../db'
import { clientIp, isOff } from '../../handler'
import { ipHash } from '../../http/ip'
import { readJson, str } from '../../http/request'
import { err, json, noStore } from '../../http/respond'
import { authenticate, clearCookie, hasRole, issueSession, type AuthContext, type Role } from '../../auth/session'
import * as loginLimit from '../../auth/loginLimit'
import { generateTotpSecret, verifyTotp } from '../../auth/totp'
import * as gm from '../../repo/admins'
import * as bottles from '../../repo/bottles'
import * as gallery from '../../repo/gallery'
import * as news from '../../repo/news'
import * as reports from '../../repo/reports'
import * as stats from '../../repo/stats'

interface Ctx {
  req: Request
  url: URL
  cfg: ServerConfig
  now: number
  db: Db
  /** 受保护路由才有 */
  auth?: AuthContext
}

type RouteFn = (ctx: Ctx, m: RegExpExecArray) => Promise<Response>

interface RouteDef {
  method: string
  re: RegExp
  need: Role | 'public'
  fn: RouteFn
}

const ROUTES: RouteDef[] = []

function route(method: string, pattern: string, need: Role | 'public', fn: RouteFn): void {
  const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, '([A-Za-z0-9_-]{1,80})') + '$')
  ROUTES.push({ method, re, need, fn })
}

function authOf(ctx: Ctx): AuthContext {
  if (!ctx.auth) throw new Error('route 缺少 auth 上下文')
  return ctx.auth
}

// ---------- 登录 / 会话 ----------

route('POST', '/admin/api/login', 'public', async (ctx) => {
  const { req, cfg, now, db } = ctx
  const body = await readJson(req, 8 * 1024)
  if (!body.ok) return err('VALIDATION', 400)
  const apiKey = str(body.value.apiKey, 200)
  const totp = str(body.value.totp, 10)
  const username = str(body.value.username, 64) || 'admin'
  if (!apiKey || !totp) return err('VALIDATION', 400)

  if (!sameOrigin(req, cfg)) return err('FORBIDDEN', 403)

  const ip = await ipHash(clientIp(req, cfg))
  const accountKey = { kind: 'account' as const, username }
  const ipKey = ip ? ({ kind: 'ip' as const, ipHash: ip }) : null

  // 先快速拒绝已锁定的账号/IP（不计数）
  if (await loginLimit.isLocked(db, accountKey, now)) return err('LOGIN_LOCKED', 429)
  if (ipKey && (await loginLimit.isLocked(db, ipKey, now))) return err('LOGIN_LOCKED', 429)

  // 原子计数；超限即拒
  if ((await loginLimit.registerAttempt(db, accountKey, now)).locked) return err('LOGIN_LOCKED', 429)
  if (ipKey && (await loginLimit.registerAttempt(db, ipKey, now)).locked) return err('LOGIN_LOCKED', 429)

  const admin = await gm.findByUsername(db, username)
  if (!admin || admin.disabled) return err('ADMIN_UNAUTHORIZED', 401)

  if ((await hashSecret(apiKey, 'admin-key')) !== admin.key_hash) return err('ADMIN_UNAUTHORIZED', 401)

  // TOTP：密钥用 AES-GCM 加密存储
  let ok = false
  try {
    ok = await verifyTotp(await openSecret(admin.totp_secret, cfg.totpMasterKey ?? ''), totp, now)
  } catch {
    return err('VALIDATION', 500)
  }
  if (!ok) return err('BAD_TOTP', 401)

  await loginLimit.clearAfterSuccess(db, accountKey, now)
  if (ipKey) await loginLimit.clearAfterSuccess(db, ipKey, now)

  const s = await issueSession(db, admin.id, now)
  await gm.touchLogin(db, admin.id, now)
  await audit(db, admin.id, 'login', admin.id, null, now)

  return json({ ok: true, me: { id: admin.id, username: admin.username, role: admin.role } }, 200, {
    ...noStore(),
    'Set-Cookie': s.cookie,
  })
})

route('POST', '/admin/api/logout', 'public', async (ctx) => {
  const { req, cfg, now } = ctx
  const a = await authenticate(cfg.db, req, now)
  if (a) {
    await gm.deleteSession(cfg.db, a.tokenHash)
    await audit(cfg.db, a.auth.adminId, 'logout', a.auth.adminId, null, now)
  }
  return json({ ok: true }, 200, { ...noStore(), 'Set-Cookie': clearCookie() })
})

route('GET', '/admin/api/me', 'viewer', async (ctx) => {
  const admin = await gm.findById(ctx.db, authOf(ctx).adminId)
  if (!admin) return err('ADMIN_UNAUTHORIZED', 401)
  return json({ ok: true, id: admin.id, username: admin.username, role: admin.role }, 200, noStore())
})

// ---------- 概览 ----------

route('GET', '/admin/api/overview', 'viewer', async (ctx) => {
  const { cfg, now, db } = ctx
  const pending = await gallery.countByStatus(db, 'pending')
  const open = await reports.countOpen(db)
  const oldest = await reports.oldestOpenAt(db)
  const oldestHours = oldest ? Math.max(0, Math.floor((now - oldest) / 3600000)) : 0

  const day = stats.dayKey(now)
  const r = stats.ratios(await stats.range(db, shiftDay(day, -6), day))
  const seed = await gallery.seedShare(db, now)

  const [eOff, gOff, nOff, rOff] = await Promise.all([
    isOff('EMERGENCY_OFF', cfg),
    isOff('GALLERY_OFF', cfg),
    isOff('NEWS_OFF', cfg),
    isOff('REPLY_OFF', cfg),
  ])

  const utc = new Date(now)
  const dayStart = Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate())
  const newsToday = await news.countPublishedToday(db, dayStart, dayStart + 86400000)

  const alerts: string[] = []
  if (eOff) alerts.push('封海状态：所有写接口已关闭')
  if (oldestHours >= 2) alerts.push(`有举报已等待 ${oldestHours} 小时未处理`)
  if (r.reportRate > 0.005) alerts.push(`举报率 ${(r.reportRate * 100).toFixed(2)}% 已超过 0.5% 红线`)
  if (seed >= 0.3) alerts.push(`种子内容占比 ${(seed * 100).toFixed(0)}%，真实内容不足`)

  return json(
    {
      ok: true,
      todo: { galleryPending: pending, reportsOpen: open, oldestReportHours: oldestHours, newsPublishedToday: newsToday },
      ratios: { pickRate: r.pickRate, replyRate: r.replyRate, reportRate: r.reportRate, seedShare: seed },
      flags: { EMERGENCY_OFF: eOff, GALLERY_OFF: gOff, NEWS_OFF: nOff, REPLY_OFF: rOff },
      alerts,
    },
    200,
    noStore(),
  )
})

// ---------- 值班：橱窗待审 ----------

route('GET', '/admin/api/moderation', 'operator', async ({ url, db }) => {
  const status = ['pending', 'approved', 'rejected', 'withdrawn'].includes(String(url.searchParams.get('status')))
    ? String(url.searchParams.get('status'))
    : 'pending'
  const rows = await gallery.listForAdmin(db, { status, limit: 50 })
  return json({ ok: true, items: rows.map(toGalleryAdmin) }, 200, noStore())
})

route('POST', '/admin/api/moderation/:id', 'operator', async (ctx, m) => {
  const { req, now, db } = ctx
  const a = authOf(ctx)
  const body = await readJson(req)
  if (!body.ok) return err('VALIDATION', 400)
  const action = String(body.value.action)
  if (action !== 'approve' && action !== 'reject') return err('VALIDATION', 400)
  const note = str(body.value.note, 200) || action

  const ok = await gallery.review(db, {
    id: m[1]!,
    status: action === 'approve' ? 'approved' : 'rejected',
    reviewer: a.adminId,
    note,
    now,
    ttlDays: 30,
  })
  if (!ok) return err('NOT_PENDING', 409)
  await audit(db, a.adminId, `gallery.${action}`, m[1]!, note, now)
  return json({ ok: true }, 200, noStore())
})

// ---------- 值班：举报 ----------

route('GET', '/admin/api/reports', 'operator', async ({ db }) => {
  const rows = await reports.listOpen(db, 50)
  // 只按 id 精确附加被举报的那条内容（隐私边界唯一的窄缝）
  const items = await Promise.all(
    rows.map(async (r) => {
      let target: { kind: 'bottle' | 'reply'; body: string; alias: string; hidden: boolean } | null = null
      if (r.bottle_id) {
        const b = await bottles.findByIdForReport(db, r.bottle_id)
        // 瓶子可能已被隐藏或删除；举报时留的快照保证审核员仍能看到内容
        if (b) target = { kind: 'bottle', body: b.body, alias: b.alias, hidden: b.hidden === 1 }
        else if (r.snapshot_body) target = { kind: 'bottle', body: r.snapshot_body, alias: r.snapshot_alias ?? '—', hidden: true }
      } else if (r.reply_id) {
        const rp = await reports.findReplyForReport(db, r.reply_id)
        if (rp) target = { kind: 'reply', body: rp.body, alias: rp.alias, hidden: rp.hidden === 1 }
      }
      return { id: r.id, reason: r.reason, createdAt: r.created_at, target }
    }),
  )
  return json({ ok: true, items }, 200, noStore())
})

route('POST', '/admin/api/reports/:id', 'operator', async (ctx, m) => {
  const { req, now, db } = ctx
  const a = authOf(ctx)
  const body = await readJson(req)
  if (!body.ok) return err('VALIDATION', 400)
  const action = String(body.value.action)
  if (action !== 'hide' && action !== 'keep') return err('VALIDATION', 400)

  const report = await reports.findById(db, m[1]!)
  if (!report) return err('NOT_FOUND', 404)

  if (action === 'hide') {
    if (report.bottle_id) {
      await bottles.hideBottle(db, report.bottle_id, report.reason)
      await gallery.withdrawBySourceBottle(db, report.bottle_id, now)
    }
    if (report.reply_id) await bottles.hideReply(db, report.reply_id)
  }
  if (!(await reports.handle(db, { id: m[1]!, action, by: a.adminId, now }))) return err('NOT_PENDING', 409)
  await audit(db, a.adminId, `report.${action}`, m[1]!, null, now)
  return json({ ok: true }, 200, noStore())
})

// ---------- 橱窗管理 ----------

route('GET', '/admin/api/gallery', 'operator', async ({ url, db }) => {
  const status = String(url.searchParams.get('status')) || undefined
  const pool = String(url.searchParams.get('pool')) || undefined
  const rows = await gallery.listForAdmin(db, { status, pool, limit: 50 })
  return json({ ok: true, items: rows.map(toGalleryAdmin) }, 200, noStore())
})

route('POST', '/admin/api/gallery/:id/unpublish', 'operator', async (ctx, m) => {
  const { req, now, db } = ctx
  const a = authOf(ctx)
  const body = await readJson(req)
  const note = str(body.ok ? body.value.note : '', 200) || 'unpublished'
  if (!(await gallery.withdraw(db, m[1]!, note, now))) return err('NOT_PENDING', 409)
  await audit(db, a.adminId, 'gallery.unpublish', m[1]!, note, now)
  return json({ ok: true }, 200, noStore())
})

/** 后台新增官方种子（前台不标记；概览会对占比告警） */
route('POST', '/admin/api/gallery/seed', 'operator', async (ctx) => {
  const { req, now, db } = ctx
  const a = authOf(ctx)
  const body = await readJson(req)
  if (!body.ok) return err('VALIDATION', 400)
  const text = str(body.value.body, 60)
  if (!text) return err('VALIDATION', 400)
  const pool = ['night', 'morning', 'day', 'evening'].includes(String(body.value.pool)) ? String(body.value.pool) : 'night'
  await gallery.insertPending(db, { id: randomId(), sourceBottle: null, pool, body: text, alias: '海边的猫', seed: true, now })
  await audit(db, a.adminId, 'gallery.seed', null, pool, now)
  return json({ ok: true }, 200, noStore())
})

// ---------- 新闻编排 ----------

route('GET', '/admin/api/news', 'operator', async ({ url, db }) => {
  const status = String(url.searchParams.get('status')) || undefined
  const rows = await news.listForAdmin(db, { status, limit: 50 })
  return json({ ok: true, items: rows.map(toNewsAdmin) }, 200, noStore())
})

interface Draft {
  title: string
  summary: string
  body: string
  sourceName: string | null
  sourceUrl: string | null
  category: string
}

function readDraft(v: Record<string, unknown>): Draft | null {
  const title = str(v.title, NEWS_TITLE_MAX)
  const summary = str(v.summary, NEWS_SUMMARY_MAX)
  const body = str(v.body, NEWS_BODY_MAX)
  if (!title || !summary || !body) return null
  return {
    title,
    summary,
    body,
    sourceName: str(v.sourceName, 80) || null,
    sourceUrl: str(v.sourceUrl, 500) || null,
    category: ['rain', 'night', 'city', 'cat', 'other'].includes(String(v.category)) ? String(v.category) : 'other',
  }
}

route('POST', '/admin/api/news', 'operator', async (ctx) => {
  const { req, now, db } = ctx
  const a = authOf(ctx)
  const body = await readJson(req, 32 * 1024)
  if (!body.ok) return err('VALIDATION', 400)
  const d = readDraft(body.value)
  if (!d) return err('VALIDATION', 400)

  const id = randomId()
  await news.insertDraft(db, { id, ...d, coverKey: null, createdBy: a.adminId, now })

  // 若来自线索，顺手标记已用
  const leadId = str(body.value.leadId, 80)
  if (leadId) await news.markLead(db, { id: leadId, status: 'used', usedNewsId: id })

  await audit(db, a.adminId, 'news.create', id, d.title, now)
  return json({ ok: true, id }, 200, noStore())
})

route('PATCH', '/admin/api/news/:id', 'operator', async (ctx, m) => {
  const { req, now, db } = ctx
  const a = authOf(ctx)
  const body = await readJson(req, 32 * 1024)
  if (!body.ok) return err('VALIDATION', 400)
  const d = readDraft(body.value)
  if (!d) return err('VALIDATION', 400)
  if (!(await news.updateDraft(db, { id: m[1]!, ...d, coverKey: null, now }))) return err('NOT_PENDING', 409)
  await audit(db, a.adminId, 'news.update', m[1]!, d.title, now)
  return json({ ok: true }, 200, noStore())
})

route('POST', '/admin/api/news/:id/publish', 'operator', async (ctx, m) => {
  const { req, now, db } = ctx
  const a = authOf(ctx)
  const body = await readJson(req)
  const at = body.ok && Number.isFinite(Number(body.value.publishAt)) ? Number(body.value.publishAt) : now
  const status: 'published' | 'scheduled' = at > now + 60_000 ? 'scheduled' : 'published'
  if (!(await news.setPublish(db, { id: m[1]!, status, publishAt: at, now }))) return err('NOT_PENDING', 409)
  await audit(db, a.adminId, `news.${status}`, m[1]!, new Date(at).toISOString(), now)
  return json({ ok: true, status, publishAt: at }, 200, noStore())
})

route('POST', '/admin/api/news/:id/archive', 'operator', async (ctx, m) => {
  const { now, db } = ctx
  const a = authOf(ctx)
  if (!(await news.archive(db, m[1]!, now))) return err('NOT_PENDING', 409)
  await audit(db, a.adminId, 'news.archive', m[1]!, null, now)
  return json({ ok: true }, 200, noStore())
})

// ---------- 线索 ----------

route('GET', '/admin/api/leads', 'operator', async ({ url, db }) => {
  const status = String(url.searchParams.get('status')) || 'new'
  const rows = await news.listLeads(db, { status, limit: 50 })
  return json(
    {
      ok: true,
      items: rows.map((r) => ({
        id: r.id,
        rawTitle: r.raw_title,
        rawSummary: r.raw_summary,
        sourceName: r.source_name,
        sourceUrl: r.source_url,
        suggestedCategory: r.suggested_category,
        fetchedAt: r.fetched_at,
        fingerprint: r.fingerprint,
        status: r.status,
        usedNewsId: r.used_news_id,
        createdAt: r.created_at,
      })),
    },
    200,
    noStore(),
  )
})

route('POST', '/admin/api/leads/:id/ignore', 'operator', async (ctx, m) => {
  const { now, db } = ctx
  const a = authOf(ctx)
  if (!(await news.markLead(db, { id: m[1]!, status: 'ignored' }))) return err('NOT_PENDING', 409)
  await audit(db, a.adminId, 'lead.ignore', m[1]!, null, now)
  return json({ ok: true }, 200, noStore())
})

// ---------- 封海开关 ----------

route('GET', '/admin/api/flags', 'viewer', async ({ db }) => {
  const rows = await gm.listFlags(db)
  return json(
    { ok: true, items: rows.map((r) => ({ key: r.key, value: r.value === 1, reason: r.reason, updatedAt: r.updated_at })) },
    200,
    noStore(),
  )
})

route('POST', '/admin/api/flags', 'admin', async (ctx) => {
  const { req, now, db } = ctx
  const a = authOf(ctx)
  const body = await readJson(req)
  if (!body.ok) return err('VALIDATION', 400)
  const key = String(body.value.key)
  const reason = str(body.value.reason, 200)
  if (!(FLAG_KEYS as readonly string[]).includes(key)) return err('VALIDATION', 400)
  // 开关必须带理由：审计里要能看出「为什么关」
  if (!reason) return err('VALIDATION', 400)
  await gm.setFlag(db, { key, value: body.value.value === true, reason, by: a.adminId, now })
  await audit(db, a.adminId, 'flag.set', key, `${body.value.value === true} ${reason}`, now)
  return json({ ok: true }, 200, noStore())
})

// ---------- 审计 ----------

route('GET', '/admin/api/audit', 'viewer', async ({ url, db }) => {
  const actor = String(url.searchParams.get('actor')) || undefined
  const action = String(url.searchParams.get('action')) || undefined
  const rows = await gm.listAudit(db, { actor, action, limit: 100 })
  return json(
    {
      ok: true,
      items: rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        target: r.target,
        detail: r.detail,
        createdAt: r.created_at,
      })),
    },
    200,
    noStore(),
  )
})

// ---------- 守塔人 ----------

route('GET', '/admin/api/admins', 'admin', async ({ db }) => {
  const rows = await gm.listAdmins(db)
  return json(
    {
      ok: true,
      items: rows.map((r) => ({
        id: r.id,
        username: r.username,
        role: r.role,
        disabled: r.disabled === 1,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
      })),
    },
    200,
    noStore(),
  )
})

route('POST', '/admin/api/admins', 'admin', async (ctx) => {
  const { req, cfg, now, db } = ctx
  const a = authOf(ctx)
  const body = await readJson(req)
  if (!body.ok) return err('VALIDATION', 400)
  const username = str(body.value.username, 64)
  const role = String(body.value.role)
  if (!username || !['viewer', 'operator', 'admin'].includes(role)) return err('VALIDATION', 400)
  if (await gm.findByUsername(db, username)) return err('VALIDATION', 409)
  if (!cfg.totpMasterKey) return err('VALIDATION', 500)

  const apiKey = randomSecret()
  const totpSecret = generateTotpSecret()
  const id = randomId()
  await gm.insertAdmin(db, {
    id,
    username,
    keyHash: await hashSecret(apiKey, 'admin-key'),
    totpSecret: await sealSecret(totpSecret, cfg.totpMasterKey),
    role,
    now,
  })
  await audit(db, a.adminId, 'admin.create', id, `${username} ${role}`, now)

  // 只展示一次：API Key 与 TOTP 密钥
  return json({ ok: true, id, username, role, apiKey, totpSecret }, 200, noStore())
})

route('PATCH', '/admin/api/admins/:id', 'admin', async (ctx, m) => {
  const { req, now, db } = ctx
  const a = authOf(ctx)
  const body = await readJson(req)
  if (!body.ok) return err('VALIDATION', 400)
  const role = body.value.role === undefined ? undefined : String(body.value.role)
  if (role && !['viewer', 'operator', 'admin'].includes(role)) return err('VALIDATION', 400)
  const disabled = body.value.disabled === undefined ? undefined : body.value.disabled === true
  await gm.updateAdmin(db, { id: m[1]!, role, disabled })
  await audit(db, a.adminId, 'admin.update', m[1]!, JSON.stringify({ role, disabled }), now)
  return json({ ok: true }, 200, noStore())
})

route('POST', '/admin/api/admins/:id/reset-key', 'admin', async (ctx, m) => {
  const { now, db } = ctx
  const a = authOf(ctx)
  const apiKey = randomSecret()
  await gm.resetKeyHash(db, m[1]!, await hashSecret(apiKey, 'admin-key'))
  await audit(db, a.adminId, 'admin.resetKey', m[1]!, null, now)
  return json({ ok: true, apiKey }, 200, noStore())
})

// ---------- 设备封禁 ----------

route('POST', '/admin/api/devices/:hash/revoke', 'admin', async (ctx, m) => {
  const { req, now, db } = ctx
  const a = authOf(ctx)
  const body = await readJson(req)
  const note = str(body.ok ? body.value.note : '', 200) || 'revoked'
  await bottles.revokeToken(db, m[1]!, note, now)
  await audit(db, a.adminId, 'device.revoke', m[1]!, note, now)
  return json({ ok: true }, 200, noStore())
})

route('POST', '/admin/api/devices/:hash/unrevoke', 'admin', async (ctx, m) => {
  const { now, db } = ctx
  const a = authOf(ctx)
  await bottles.unrevokeToken(db, m[1]!)
  await audit(db, a.adminId, 'device.unrevoke', m[1]!, null, now)
  return json({ ok: true }, 200, noStore())
})

// ---------- 公共入口 ----------

export async function handle(req: Request, url: URL, cfg: ServerConfig, now: number): Promise<Response> {
  for (const r of ROUTES) {
    if (r.method !== req.method) continue
    const m = r.re.exec(url.pathname)
    if (!m) continue

    const ctx: Ctx = { req, url, cfg, now, db: cfg.db }

    if (r.need === 'public') return r.fn(ctx, m)
    const a = await authenticate(cfg.db, req, now)
    if (!a) return err('ADMIN_UNAUTHORIZED', 401)
    if (!hasRole(a.auth.role, r.need as Role)) return err('FORBIDDEN', 403)
    ctx.auth = a.auth
    return r.fn(ctx, m)
  }
  return err('NOT_FOUND', 404)
}

// ---------- 内部工具 ----------

function sameOrigin(req: Request, cfg: ServerConfig): boolean {
  const origin = req.headers.get('Origin')
  if (!origin || !cfg.siteOrigin) return true // 无 Origin（非浏览器）或未配置时放行，由会话兜底
  try {
    return new URL(origin).origin === new URL(cfg.siteOrigin).origin
  } catch {
    return false
  }
}

async function audit(
  db: Db,
  actor: string,
  action: string,
  target: string | null,
  detail: string | null,
  now: number,
): Promise<void> {
  try {
    await gm.addAudit(db, { id: randomId(), actor, action, target, detail, now })
  } catch {
    /* 审计失败不阻断业务 */
  }
}

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = Date.UTC(y!, (m ?? 1) - 1, (d ?? 1) + delta)
  return new Date(t).toISOString().slice(0, 10)
}

function toGalleryAdmin(r: gallery.GalleryRow) {
  return {
    id: r.id,
    body: r.body,
    alias: r.alias,
    pool: r.pool,
    status: r.status,
    seed: r.seed === 1,
    sourceBottle: r.source_bottle,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
    expiresAt: r.expires_at,
  }
}

function toNewsAdmin(r: news.NewsRow) {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    body: r.body,
    sourceName: r.source_name,
    sourceUrl: r.source_url,
    category: r.category,
    coverKey: r.cover_key,
    status: r.status,
    publishAt: r.publish_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
