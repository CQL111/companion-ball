// tests/presence.test.ts - 在场判断与久坐计时单测
import { describe, expect, it } from 'vitest'
import {
  AWAY_AFTER_MS,
  LONG_AWAY_MS,
  SIT_REMIND_DAILY_MAX,
  dayKey,
  initSit,
  isLongAway,
  pickSitLine,
  presenceOf,
  reduceSit,
  sitCheck,
} from '@core/presence'

const MIN = 60 * 1000
const T0 = new Date('2026-11-20T09:00:00').getTime()

describe('在场判断', () => {
  it('空闲超过阈值算离开', () => {
    expect(presenceOf(0)).toBe('active')
    expect(presenceOf(AWAY_AFTER_MS - 1)).toBe('active')
    expect(presenceOf(AWAY_AFTER_MS)).toBe('away')
  })

  it('可以自定义阈值（测试与不同平台）', () => {
    expect(presenceOf(30_000, { awayAfterMs: 10_000 })).toBe('away')
  })

  it('离开超过两小时算「很久」', () => {
    expect(isLongAway(LONG_AWAY_MS - 1)).toBe(false)
    expect(isLongAway(LONG_AWAY_MS)).toBe(true)
  })
})

describe('久坐计时', () => {
  it('刚开始不提醒（间隔未到）', () => {
    const s = initSit(T0, dayKey(T0))
    expect(sitCheck(s, T0 + 10 * MIN).shouldRemind).toBe(false)
    expect(sitCheck(s, T0 + 10 * MIN).reason).toBe('not-yet')
  })

  it('连续使用超过 50 分钟提醒一次', () => {
    const s = initSit(T0, dayKey(T0))
    expect(sitCheck(s, T0 + 55 * MIN).shouldRemind).toBe(true)
  })

  it('离开后计时重置（离开不算久坐）', () => {
    let s = initSit(T0, dayKey(T0))
    // 坐了 40 分钟
    const awayAt = T0 + 40 * MIN
    s = reduceSit(s, { type: 'away', now: awayAt })
    // 回来后再坐 20 分钟 —— 不应该提醒
    expect(sitCheck(s, awayAt + 20 * MIN).shouldRemind).toBe(false)
  })

  it('提醒后有冷却，不会连续打断', () => {
    let s = initSit(T0, dayKey(T0))
    const now = T0 + 55 * MIN
    s = reduceSit(s, { type: 'reminded', now, day: dayKey(now) })
    expect(sitCheck(s, now + 5 * MIN).shouldRemind).toBe(false)
    expect(sitCheck(s, now + 5 * MIN).reason).toBe('cooldown')
  })

  it('每日提醒次数有上限', () => {
    let s = initSit(T0, dayKey(T0))
    let now = T0
    for (let i = 0; i < SIT_REMIND_DAILY_MAX; i++) {
      now += 60 * MIN
      s = reduceSit(s, { type: 'reminded', now, day: dayKey(now) })
    }
    now += 60 * MIN
    const check = sitCheck(s, now)
    expect(check.shouldRemind).toBe(false)
    expect(check.reason).toBe('daily-limit')
  })

  it('跨天会重置每日计数', () => {
    let s = initSit(T0, dayKey(T0))
    s = reduceSit(s, { type: 'reminded', now: T0 + 60 * MIN, day: dayKey(T0) })
    expect(s.todayCount).toBe(1)
    const nextDay = T0 + 24 * 60 * MIN
    s = reduceSit(s, { type: 'active', now: nextDay })
    expect(s.todayCount).toBe(0)
  })

  it('提醒计数按本地日期归属', () => {
    let s = initSit(T0, dayKey(T0))
    s = reduceSit(s, { type: 'reminded', now: T0, day: dayKey(T0) })
    const nextDay = T0 + 24 * 60 * MIN
    s = reduceSit(s, { type: 'reminded', now: nextDay, day: dayKey(nextDay) })
    expect(s.todayCount).toBe(1)
    expect(s.day).toBe(dayKey(nextDay))
  })
})

describe('提醒文案', () => {
  it('轮换使用，不会每次都同一句', () => {
    expect(pickSitLine(0)).not.toBe(pickSitLine(1))
  })
  it('不出现指责或说教口吻', () => {
    for (const i of [0, 1, 2, 3, 4]) {
      const line = pickSitLine(i)
      expect(line).not.toMatch(/必须|应该|错误|警告/)
      expect(line.length).toBeLessThanOrEqual(30)
    }
  })
})
