// lifecycle.ts - 瓶子的生命周期与状态机
import { BOTTLE_TTL_DAYS, DAILY_BOTTLE_LIMIT, MAX_PICKS } from './constants'
import type { BottleState, BottleStatus } from './types'

export function expiresAt(createdAtMs: number): number {
  return createdAtMs + BOTTLE_TTL_DAYS * 24 * 60 * 60 * 1000
}

export function isExpired(bottle: { expiresAt: number }, nowMs: number): boolean {
  return nowMs >= bottle.expiresAt
}

export function statusOf(b: BottleState, nowMs: number): BottleStatus {
  if (b.replyId) return 'replied'
  if (isExpired(b, nowMs)) return 'sunk'
  if (b.picks > 0) return 'picked'
  return 'floating'
}

/** 是否还能被捡 */
export function canPick(b: BottleState, nowMs: number): boolean {
  if (b.replyId) return false
  if (isExpired(b, nowMs)) return false
  return b.picks < MAX_PICKS
}

/** 是否还能被回（一个瓶子最多收一封回信） */
export function canReply(b: BottleState, nowMs: number): boolean {
  if (b.replyId) return false
  return !isExpired(b, nowMs)
}

/**
 * 客户端「猫出门」的节奏：不是每次出门都带东西回来。
 * 返回本次出门是否该带回一张纸条（由服务端决定是否真的有货）。
 */
export function shouldGoOut(nowMs: number, lastOutAt: number, random: () => number = Math.random): boolean {
  const GAP_MS = 45 * 60 * 1000 // 至少 45 分钟一次
  if (nowMs - lastOutAt < GAP_MS) return false
  return random() < 0.35
}

/** 每日配额判断（服务端同样校验，这里用于客户端提前提示） */
export function withinDailyLimit(todayCount: number, limit = DAILY_BOTTLE_LIMIT): boolean {
  return todayCount < limit
}
