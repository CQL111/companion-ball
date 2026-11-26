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
  resumeAbsence,
  sampleAbsence,
  sitCheck,
  suspendAbsence,
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

describe('离开 / 回来的转移（S4 修复）', () => {
  const active = { active: true, awaySince: 0 }
  const away = (since: number) => ({ active: false, awaySince: since })

  it('空闲超时 → 离开，记下起点', () => {
    const r = sampleAbsence(active, { now: T0, idleMs: AWAY_AFTER_MS })
    expect(r.next.active).toBe(false)
    expect(r.next.awaySince).toBe(T0)
    expect(r.event).toEqual({ type: 'away', awayStart: T0 })
  })

  it('空闲阈值内 → 不离开', () => {
    expect(sampleAbsence(active, { now: T0, idleMs: AWAY_AFTER_MS - 1 }).event).toBe(null)
  })

  it('已经在离开中 → 不重复发 away', () => {
    const r = sampleAbsence(away(T0 - 600_000), { now: T0, idleMs: AWAY_AFTER_MS })
    expect(r.event).toBe(null)
  })

  it('回到活跃 → 发 back，离开时长按起点算', () => {
    const start = T0 - 3 * 60 * MIN
    const r = sampleAbsence(away(start), { now: T0, idleMs: 0 })
    expect(r.next.active).toBe(true)
    expect(r.event).toEqual({ type: 'back', awayStart: start, awayMs: T0 - start })
  })

  it('本来就在活跃 → 不发 back（避免每轮轮询都唤醒一次）', () => {
    expect(sampleAbsence(active, { now: T0, idleMs: 0 }).event).toBe(null)
  })

  it('系统挂起：用挂起时刻作为离开起点', () => {
    const r = suspendAbsence(active, T0)
    expect(r.next.active).toBe(false)
    expect(r.next.awaySince).toBe(T0)
  })

  // 这是真实故障：合盖睡眠 3 小时后醒来，getSystemIdleTime() 从 0 重计。
  // 若用「醒来时刻 - 离开起点」以外的办法，离开时长会被算成几十秒。
  it('系统唤醒：离开时长 = 唤醒时刻 - 挂起时刻，不受空闲秒数影响', () => {
    const slept = suspendAbsence(active, T0)
    const woke = resumeAbsence(slept.next, T0 + 3 * 60 * MIN)
    expect(woke.event).toEqual({ type: 'back', awayStart: T0, awayMs: 3 * 60 * MIN })
    expect(woke.next.active).toBe(true)
  })

  it('唤醒但本来没睡（事件重放）→ 不发 back', () => {
    expect(resumeAbsence(active, T0).event).toBe(null)
  })
})
