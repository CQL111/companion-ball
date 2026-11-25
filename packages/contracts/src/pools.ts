// pools.ts - 按本地时间分池（服务端不保存时区或坐标）
import type { Pool } from './types'

/**
 * 按时段分池。只返回时段标签——服务端不保存时区或坐标。
 * @param utcOffsetMinutes 客户端时区偏移（东八区 = 480）
 */
export function poolFor(nowMs: number, utcOffsetMinutes: number): Pool {
  const localMs = nowMs + utcOffsetMinutes * 60 * 1000
  const hour = new Date(localMs).getUTCHours()
  if (hour >= 22 || hour < 5) return 'night'
  if (hour < 11) return 'morning'
  if (hour < 18) return 'day'
  return 'evening'
}

/** 是否「深夜」——用于客户端文案（「这个时间还没睡的人」） */
export function isLateNight(pool: Pool): boolean {
  return pool === 'night'
}
