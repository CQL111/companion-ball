// tests/needs.test.ts - 「它需要你」单测：可拒绝、不惩罚、有配额
import { describe, expect, it } from 'vitest'
import {
  DECLINE_QUIET_MS,
  NEED_GAP_MS,
  NEEDS_DAILY_MAX,
  initNeeds,
  isQuietHour,
  nextNeed,
  pickNeedLine,
  pickSatisfiedLine,
  reduceNeeds,
  type NeedsState,
} from '@core/needs'

const MIN = 60 * 1000
const T0 = new Date('2026-11-20T10:00:00').getTime()
const DAY = '2026-11-20'

function fresh(now = T0): NeedsState {
  return initNeeds(now, DAY)
}

describe('提出需求的时机', () => {
  it('刚启动不立刻提', () => {
    expect(nextNeed(fresh(), T0 + 10 * MIN)).toBeNull()
  })

  it('间隔足够后提出第一种需求', () => {
    expect(nextNeed(fresh(), T0 + NEED_GAP_MS + 1)).toBe('hungry')
  })

  it('三种需求轮流来', () => {
    let s = fresh()
    const kinds: Array<string | null> = []
    let now = T0
    for (let i = 0; i < 3; i++) {
      now += NEED_GAP_MS + 1
      const k = nextNeed(s, now, { dailyMax: 5 })
      kinds.push(k)
      if (k) s = reduceNeeds(s, { type: 'raise', now, kind: k })
      now += 60 * MIN
      s = reduceNeeds(s, { type: 'satisfy', now })
    }
    expect(kinds).toEqual(['hungry', 'bored', 'lonely'])
  })

  it('每天最多提 2 次', () => {
    let s = fresh()
    let now = T0
    for (let i = 0; i < NEEDS_DAILY_MAX; i++) {
      now += NEED_GAP_MS + 1
      const k = nextNeed(s, now)
      expect(k).not.toBeNull()
      s = reduceNeeds(s, { type: 'raise', now, kind: k! })
      now += 60 * MIN
      s = reduceNeeds(s, { type: 'satisfy', now })
    }
    now += NEED_GAP_MS + 1
    expect(nextNeed(s, now)).toBeNull()
  })

  it('深夜不提需求（0–6 点）', () => {
    const three = new Date('2026-11-20T03:00:00').getTime()
    expect(isQuietHour(three)).toBe(true)
    expect(nextNeed({ ...fresh(three), lastActedAt: three - NEED_GAP_MS - 1 }, three)).toBeNull()
  })

  it('已有请求未过期时不重复提', () => {
    const s = reduceNeeds(fresh(), { type: 'raise', now: T0 + NEED_GAP_MS + 1, kind: 'hungry' })
    expect(nextNeed(s, T0 + NEED_GAP_MS + 2)).toBeNull()
  })
})

describe('可拒绝且不惩罚', () => {
  it('拒绝后安静一段时间', () => {
    let s = fresh()
    const raiseAt = T0 + NEED_GAP_MS + 1
    s = reduceNeeds(s, { type: 'raise', now: raiseAt, kind: 'hungry' })
    s = reduceNeeds(s, { type: 'decline', now: raiseAt + 1000 })
    expect(s.active).toBeNull()
    // 安静期内不会再提
    expect(nextNeed(s, raiseAt + 10 * MIN)).toBeNull()
    // 两个间隔叠在一起：安静期 + 两次请求的最小间隔（拒绝发生得比提出晚）
    expect(nextNeed(s, raiseAt + DECLINE_QUIET_MS + NEED_GAP_MS + 2000)).not.toBeNull()
  })

  it('拒绝不消耗什么：没有「好感」或「心情」字段被扣', () => {
    const s0 = fresh()
    const raised = reduceNeeds(s0, { type: 'raise', now: T0 + NEED_GAP_MS + 1, kind: 'hungry' })
    const declined = reduceNeeds(raised, { type: 'decline', now: T0 + NEED_GAP_MS + 2000 })
    // 除了 lastDeclinedAt / lastActedAt，其余与提出前一致
    expect(declined.todayCount).toBe(raised.todayCount)
    expect(declined.day).toBe(raised.day)
    expect(Object.keys(declined).sort()).toEqual(Object.keys(raised).sort())
  })

  it('请求过期后自己放弃，不纠缠', () => {
    let s = fresh()
    const raiseAt = T0 + NEED_GAP_MS + 1
    s = reduceNeeds(s, { type: 'raise', now: raiseAt, kind: 'bored' })
    s = reduceNeeds(s, { type: 'tick', now: raiseAt + 20 * MIN })
    expect(s.active).toBeNull()
  })
})

describe('跨天', () => {
  it('跨天重置每日次数', () => {
    let s = fresh()
    s = reduceNeeds(s, { type: 'raise', now: T0, kind: 'hungry' })
    expect(s.todayCount).toBe(1)
    const nextDay = T0 + 24 * 60 * MIN
    s = reduceNeeds(s, { type: 'tick', now: nextDay })
    expect(s.day).not.toBe(DAY)
    expect(s.todayCount).toBe(0)
  })
})

describe('台词', () => {
  it('每种需求都有提出与满足两种台词', () => {
    for (const k of ['hungry', 'bored', 'lonely'] as const) {
      expect(pickNeedLine(k).length).toBeGreaterThan(1)
      expect(pickSatisfiedLine(k).length).toBeGreaterThan(1)
    }
  })

  it('不乞求：台词里不出现感叹号与「求你」', () => {
    for (const k of ['hungry', 'bored', 'lonely'] as const) {
      for (let i = 0; i < 4; i++) {
        const line = pickNeedLine(k, () => i / 4)
        expect(line).not.toMatch(/[！!]|求你|拜托|必须/)
        expect(line.length).toBeLessThanOrEqual(16)
      }
    }
  })
})
