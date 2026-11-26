// routes/public/bottle.ts - 许愿瓶的四个写接口 + 举报
//
// 逻辑自 0.9.x 的 handler.ts 原样迁移，只把 SQL 移进 repo/。
// 行为不变：原子占位、举报即隐藏、限流三道闸。

import { BOTTLE_MAX_LENGTH, REPLY_MAX_LENGTH, checkText, poolFor, randomAlias } from '@companion/contracts'
import { hashToken, randomId } from '../../crypto'
import type { ServerConfig } from '../../handler'
import { quotaSince, readOffset, underRate } from '../../handler'
import { err, json } from '../../http/respond'
import * as bottles from '../../repo/bottles'
import * as gallery from '../../repo/gallery'
import * as reports from '../../repo/reports'
import * as stats from '../../repo/stats'
import { isOff } from '../../handler'

export async function throwBottle(req: Request, cfg: ServerConfig, tokenHash: string, now: number): Promise<Response> {
  const { db, limits } = cfg
  if (await bottles.isTokenRevoked(db, tokenHash)) return err('REVOKED', 403)

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const check = checkText(body.body, BOTTLE_MAX_LENGTH)
  if (!check.ok) return json({ ok: false, error: check.reason }, 200)

  const offset = readOffset(body)
  if ((await bottles.countToday(db, 'bottles', tokenHash, quotaSince(now, offset))) >= limits.dailyBottleLimit) {
    return err('DAILY_LIMIT', 429)
  }

  const id = randomId()
  const pool = poolFor(now, offset)
  const expiresAt = now + limits.bottleTtlDays * 86400000
  const alias = randomAlias()

  await bottles.insertBottle(db, { id, pool, body: check.cleaned, tokenHash, alias, now, expiresAt })
  await stats.bump(db, stats.dayKey(now), 'bottles_thrown')

  // 逐条 opt-in 公开：默认不勾。批准前前台不可见（WINDOW 4.3）
  if (body.requestPublic === true && !(await isOff('GALLERY_OFF', cfg))) {
    await gallery.insertPending(db, {
      id: randomId(),
      sourceBottle: id,
      pool,
      body: check.cleaned,
      alias,
      now,
    })
  }

  return json({ ok: true, id, expiresAt, alias })
}

/**
 * 捡瓶：先挑候选，再用条件 UPDATE 原子抢占（picks+1）。
 * 抢占失败（被别的请求抢先）就重试下一个候选，避免双发同一张。
 */
export async function pick(req: Request, cfg: ServerConfig, tokenHash: string, now: number): Promise<Response> {
  const { db, limits } = cfg
  if (await bottles.isTokenRevoked(db, tokenHash)) return err('REVOKED', 403)

  const hour = Math.floor(now / 3600000)
  if (!(await underRate(cfg.rate, `pick:${tokenHash}:${hour}`, 3600, limits.pickPerHour))) {
    return err('RATE_LIMITED', 429)
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const pool = poolFor(now, readOffset(body))

  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await bottles.findPickCandidate(
      db,
      { pool, now, maxPicks: limits.maxPicks, tokenHash },
      { ignorePool: cfg.intraTest === true },
    )
    if (!row) return json({ ok: true, bottle: null })
    if (!(await bottles.claimPick(db, row.id, limits.maxPicks))) continue // 被抢走了，换一张
    await bottles.recordPick(db, row.id, tokenHash, now)
    await stats.bump(db, stats.dayKey(now), 'bottles_picked')
    return json({ ok: true, bottle: row })
  }

  return json({ ok: true, bottle: null })
}

export async function reply(req: Request, cfg: ServerConfig, tokenHash: string, now: number): Promise<Response> {
  const { db, limits } = cfg
  if (await bottles.isTokenRevoked(db, tokenHash)) return err('REVOKED', 403)
  if (await isOff('REPLY_OFF', cfg)) return err('SERVICE_PAUSED', 503)

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const bottleId = typeof body.bottleId === 'string' ? body.bottleId : ''
  if (!bottleId) return err('NO_BOTTLE')

  const check = checkText(body.body, REPLY_MAX_LENGTH)
  if (!check.ok) return json({ ok: false, error: check.reason }, 200)

  if ((await bottles.countToday(db, 'replies', tokenHash, quotaSince(now, readOffset(body)))) >= limits.dailyReplyLimit) {
    return err('DAILY_LIMIT', 429)
  }

  // 只能回自己捡到过的瓶子（产品规则：捡到 → 看一眼 → 回一句 → 断）
  if (!(await bottles.hasPicked(db, bottleId, tokenHash))) return err('NOT_FOUND', 404)

  const replyId = randomId()
  // 原子占位：只有「还没人回」的瓶子才认这一封
  if (!(await bottles.claimReply(db, bottleId, replyId, tokenHash))) {
    const bottle = await bottles.findReplyState(db, bottleId)
    if (!bottle || bottle.hidden) return err('NOT_FOUND', 404)
    if (bottle.author_token === tokenHash) return err('SELF_REPLY', 400)
    return err('ALREADY_REPLIED', 409)
  }

  const alias = randomAlias()
  await bottles.insertReply(db, { id: replyId, bottleId, body: check.cleaned, tokenHash, alias, now })
  await stats.bump(db, stats.dayKey(now), 'replies_sent')
  return json({ ok: true, replyId, alias })
}

export async function inbox(_req: Request, cfg: ServerConfig, tokenHash: string, now: number): Promise<Response> {
  const { db, limits } = cfg
  if (await bottles.isTokenRevoked(db, tokenHash)) return err('REVOKED', 403)

  const hour = Math.floor(now / 3600000)
  if (!(await underRate(cfg.rate, `inbox:${tokenHash}:${hour}`, 3600, limits.inboxPerHour))) {
    return err('RATE_LIMITED', 429)
  }

  // 不返回回信者的任何可关联信息；回信一旦送达即视为结束
  const rows = await bottles.listInbox(db, tokenHash)
  return json({ ok: true, replies: rows })
}

export async function report(req: Request, cfg: ServerConfig, tokenHash: string, now: number): Promise<Response> {
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
  if (bottleId && !(await bottles.hasSeenForReport(db, bottleId, tokenHash))) return err('NOT_FOUND', 404)

  // 举报时先留快照：随后会被隐藏，审核员仍需要看到内容才能判断
  let snapshot: { body: string; alias: string } | null = null
  if (bottleId) {
    const b = await bottles.findByIdForReport(db, bottleId)
    if (b) snapshot = { body: b.body, alias: b.alias }
  }

  await reports.insert(db, {
    id: randomId(),
    bottleId,
    replyId,
    reason,
    now,
    snapshotBody: snapshot?.body ?? null,
    snapshotAlias: snapshot?.alias ?? null,
  })
  await stats.bump(db, stats.dayKey(now), 'reports_received')

  // 举报即隐藏：不等人工复核，先对所有人生效
  if (bottleId) {
    await bottles.hideBottle(db, bottleId, reason)
    // 橱窗副本同步下架（快照独立，但不能让被举报的内容继续公开）
    await gallery.withdrawBySourceBottle(db, bottleId, now)
  }
  if (replyId) await bottles.hideReply(db, replyId)

  return json({ ok: true })
}

/** 橱窗条目被访客举报（无需设备令牌，但限流） */
export async function reportGallery(req: Request, cfg: ServerConfig, now: number): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) return err('NO_BOTTLE')
  const reason = ['spam', 'abuse', 'other'].includes(String(body.reason)) ? String(body.reason) : 'other'

  // 前台举报直接下架：橱窗是公开内容，宁可错杀
  const ok = await gallery.withdraw(cfg.db, id, `reported:${reason}`, now)
  if (!ok) return err('NOT_FOUND', 404)
  await reports.insert(cfg.db, { id: randomId(), bottleId: null, replyId: null, reason, now })
  await stats.bump(cfg.db, stats.dayKey(now), 'reports_received')
  return json({ ok: true })
}

export { hashToken }
