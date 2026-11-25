// bottleApi.ts - 许愿瓶的网络客户端（主进程侧）
// 只负责：拼请求、带设备令牌、把错误码归一。
// 业务规则（什么能发、多久沉海）在 core/mailbox.ts；这里不重复判断。

import { net } from 'electron'
import type { BottleDTO, ReplyDTO } from '../../core/mailbox'
import { logger } from './logger'

export interface BottleEndpoint {
  baseUrl: string
  token: string
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

function clampOffset(minutes: number): number {
  return Number.isFinite(minutes) ? Math.max(-840, Math.min(840, Math.round(minutes))) : 0
}

async function post<T>(ep: BottleEndpoint, path: string, body: Record<string, unknown>): Promise<ApiResult<T>> {
  const url = ep.baseUrl.replace(/\/+$/, '') + path
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Device-Token': ep.token,
      },
      body: JSON.stringify({ ...body, utcOffsetMinutes: clampOffset(Number(body.utcOffsetMinutes ?? 0)) }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!json) {
      logger.warn('bottle.api', `${path} bad json status=${res.status}`)
      return { ok: false, error: 'NETWORK' }
    }
    if (json.ok === true) return { ok: true, data: json as T }
    const code = typeof json.error === 'string' ? json.error : `HTTP_${res.status}`
    logger.info('bottle.api', `${path} failed code=${code} status=${res.status}`)
    return { ok: false, error: code }
  } catch (e) {
    clearTimeout(timer)
    const msg = (e as Error).name === 'AbortError' ? 'NETWORK' : 'NETWORK'
    logger.warn('bottle.api', `${path} network error: ${(e as Error).message}`)
    return { ok: false, error: msg }
  }
}

export interface ThrowResult {
  id: string
  expiresAt: number
  alias: string
}

export async function throwBottle(
  ep: BottleEndpoint,
  body: string,
  utcOffsetMinutes: number,
): Promise<ApiResult<ThrowResult>> {
  const r = await post<{ id: string; expiresAt: number; alias: string }>(ep, '/v1/bottle', {
    body,
    utcOffsetMinutes,
  })
  return r.ok ? { ok: true, data: { id: r.data.id, expiresAt: r.data.expiresAt, alias: r.data.alias } } : r
}

/** 捡一个（可能空手） */
export async function pickBottle(ep: BottleEndpoint, utcOffsetMinutes: number): Promise<ApiResult<BottleDTO | null>> {
  const r = await post<{ bottle: BottleDTO | null }>(ep, '/v1/bottle/pick', { utcOffsetMinutes })
  return r.ok ? { ok: true, data: r.data.bottle ?? null } : r
}

export async function replyBottle(
  ep: BottleEndpoint,
  bottleId: string,
  body: string,
  utcOffsetMinutes: number,
): Promise<ApiResult<{ replyId: string; alias: string }>> {
  return post(ep, '/v1/bottle/reply', { bottleId, body, utcOffsetMinutes })
}

export async function fetchInbox(ep: BottleEndpoint, utcOffsetMinutes: number): Promise<ApiResult<ReplyDTO[]>> {
  const r = await post<{ replies: ReplyDTO[] }>(ep, '/v1/bottle/inbox', { utcOffsetMinutes })
  return r.ok ? { ok: true, data: r.data.replies ?? [] } : r
}

export async function reportContent(
  ep: BottleEndpoint,
  target: { bottleId?: string; replyId?: string },
  reason: 'spam' | 'abuse' | 'other',
  utcOffsetMinutes: number,
): Promise<ApiResult<null>> {
  const r = await post<unknown>(ep, '/v1/report', { ...target, reason, utcOffsetMinutes })
  return r.ok ? { ok: true, data: null } : r
}

/** 健康检查：用于设置页显示「猫邮局是否开门」 */
export async function health(baseUrl: string): Promise<{ ok: boolean; paused: boolean }> {
  try {
    const res = await net.fetch(baseUrl.replace(/\/+$/, '') + '/v1/health', {
      method: 'POST',
      headers: { 'X-Device-Token': 'health-check-0000000000000000' },
    })
    const json = (await res.json()) as { ok?: boolean; paused?: boolean }
    return { ok: !!json?.ok, paused: !!json?.paused }
  } catch {
    return { ok: false, paused: false }
  }
}
