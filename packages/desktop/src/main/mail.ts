// mail.ts - 许愿瓶的主进程编排（开关、令牌、节奏、IPC 背后的业务）
// 网络细节在 services/bottleApi.ts；领域规则在 core/mailbox.ts。

import crypto from 'node:crypto'
import * as mailbox from '../core/mailbox'
import type { BottleDTO, ReplyDTO } from '../core/mailbox'
import { logger } from './services/logger'
import * as api from './services/bottleApi'
import { getNotebook, setNotebook, store } from './store'

/**
 * 默认服务端地址。服务器部署后在这里填一行即可，用户无需手动配置。
 * 留空 = 该构建的许愿瓶未开放（界面会显示「尚未开放」）。
 * 国内版与海外版可以用不同的构建分别填写。
 */
const DEFAULT_ENDPOINT = ''

/** 设备令牌：由 installId 派生，稳定且可吊销（服务端只存哈希） */
function deviceToken(): string {
  const installId = store.get('installId') || ''
  if (!installId) return ''
  return crypto.createHmac('sha256', installId).update('companion-ball-bottle-v1').digest('hex')
}

export function bottleSettings(): mailbox.BottleSettings {
  const saved = store.get('bottle') || {}
  return {
    ...mailbox.DEFAULT_BOTTLE_SETTINGS,
    ...saved,
    // 用户没填过地址时用构建内置的默认值
    endpoint: saved.endpoint || DEFAULT_ENDPOINT,
  }
}

export function isBottleEnabled(): boolean {
  const s = bottleSettings()
  return s.enabled === true && !!s.endpoint
}

function endpoint(): api.BottleEndpoint | null {
  const s = bottleSettings()
  if (!s.enabled || !s.endpoint) return null
  const token = deviceToken()
  if (!token) return null
  return { baseUrl: s.endpoint, token }
}

/** 本地时区偏移（分钟），只上报时段标签用，服务端不落库时区 */
function utcOffset(): number {
  // getTimezoneOffset 返回「本地比 UTC 早多少分钟」，需要取反
  return -new Date().getTimezoneOffset()
}

function saveBottle(patch: Partial<mailbox.BottleSettings>): void {
  store.set('bottle', { ...bottleSettings(), ...patch })
}

export interface MailResult<T> {
  ok: boolean
  data?: T
  error?: string
  errorText?: string
}

function fail(code: string): MailResult<never> {
  return { ok: false, error: code, errorText: mailbox.bottleErrorText(code) }
}

// ---------- 扔 ----------
export async function throwBottle(body: string): Promise<MailResult<{ id: string; alias: string }>> {
  const ep = endpoint()
  if (!ep) return fail('SERVICE_PAUSED')

  const check = mailbox.checkText(body)
  if (!check.ok) return fail(check.reason || 'EMPTY')

  const todayCount = countToday()
  if (!mailbox.withinDailyLimit(todayCount)) return fail('DAILY_LIMIT')

  const r = await api.throwBottle(ep, check.cleaned, utcOffset())
  if (!r.ok) return fail(r.error)

  // 本地计数与投递放在一起：调用方不需要记得再调 markThrown
  markThrown()
  logger.info('bottle.throw', `ok alias=${r.data.alias} today=${countToday()}`)
  return { ok: true, data: { id: r.data.id, alias: r.data.alias } }
}

// ---------- 猫出门：捡一张（可能空手） ----------
export async function catGoesOut(force = false): Promise<MailResult<BottleDTO | null>> {
  const ep = endpoint()
  if (!ep) return fail('SERVICE_PAUSED')

  const s = bottleSettings()
  const now = Date.now()
  if (!force && !mailbox.shouldGoOut(now, s.lastOutAt)) {
    return { ok: true, data: null }
  }
  saveBottle({ lastOutAt: now })

  const r = await api.pickBottle(ep, utcOffset())
  if (!r.ok) return fail(r.error)

  if (!r.data) {
    logger.info('bottle.pick', 'empty-handed')
    return { ok: true, data: null }
  }
  logger.info('bottle.pick', `got alias=${r.data.alias}`)
  saveBottle({ lastPickedAt: now })
  return { ok: true, data: r.data }
}

// ---------- 回一句 ----------
export async function replyBottle(bottleId: string, body: string): Promise<MailResult<true>> {
  const ep = endpoint()
  if (!ep) return fail('SERVICE_PAUSED')

  const check = mailbox.checkText(body, mailbox.REPLY_MAX_LENGTH)
  if (!check.ok) return fail(check.reason || 'EMPTY')

  const r = await api.replyBottle(ep, bottleId, check.cleaned, utcOffset())
  if (!r.ok) return fail(r.error)
  logger.info('bottle.reply', 'ok')
  return { ok: true, data: true }
}

// ---------- 收自己收到的回信 ----------
export async function fetchInbox(): Promise<MailResult<ReplyDTO[]>> {
  const ep = endpoint()
  if (!ep) return fail('SERVICE_PAUSED')
  const r = await api.fetchInbox(ep, utcOffset())
  if (!r.ok) return fail(r.error)
  return { ok: true, data: r.data }
}

// ---------- 举报 ----------
export async function report(target: { bottleId?: string; replyId?: string }, reason: 'spam' | 'abuse' | 'other'): Promise<MailResult<true>> {
  const ep = endpoint()
  if (!ep) return fail('SERVICE_PAUSED')
  const r = await api.reportContent(ep, target, reason, utcOffset())
  if (!r.ok) return fail(r.error)
  logger.info('bottle.report', `reason=${reason}`)
  return { ok: true, data: true }
}

// ---------- 健康检查（设置页展示） ----------
export async function health(): Promise<{ ok: boolean; paused: boolean; enabled: boolean }> {
  const s = bottleSettings()
  if (!s.enabled || !s.endpoint) return { ok: false, paused: false, enabled: false }
  const h = await api.health(s.endpoint)
  return { ...h, enabled: true }
}

// ---------- 本地配额计数（按本地自然日；服务端仍会二次校验） ----------
function localDay(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
function countToday(): number {
  const raw = store.get('bottleThrownToday')
  return raw && raw.day === localDay() ? raw.n || 0 : 0
}
export function markThrown(): void {
  store.set('bottleThrownToday', { day: localDay(), n: countToday() + 1 })
}

// ---------- 笔记本收纳 ----------
/** 把收到的纸条与回信写进笔记本（同一容器，不另建列表） */
export function noteBottleInNotebook(kind: 'picked' | 'reply', text: string, alias: string): void {
  const nb = getNotebook()
  const date = new Date().toISOString().slice(0, 10)
  const line =
    kind === 'picked' ? `捡到一张纸条，落款是「${alias}」：${text}` : `「${alias}」回了我一句：${text}`
  const existing = nb.entries.find((e) => e.date === date)
  if (existing) {
    existing.lines = [...existing.lines, line].slice(0, 8)
  } else {
    nb.entries.unshift({ date, createdAt: new Date().toISOString(), lines: [line], source: 'template' })
  }
  setNotebook({ ...nb, entries: nb.entries.slice(0, 365) })
}

/** 托盘「让猫出门看看」：立即巡游一次（跳过节奏判断） */
export async function patrolOnce(): Promise<{ found: boolean; alias?: string; body?: string; errorText?: string }> {
  const r = await catGoesOut(true)
  if (!r.ok) return { found: false, errorText: r.errorText }
  if (!r.data) return { found: false }
  noteBottleInNotebook('picked', r.data.body, r.data.alias)
  return { found: true, alias: r.data.alias, body: r.data.body }
}
