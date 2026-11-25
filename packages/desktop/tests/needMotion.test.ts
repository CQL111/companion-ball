// tests/needMotion.test.ts - P0.5「不说话的身体」
// 守住三件事：需求能变成可执行的动作、不会在睡觉时表现、不会凭空乱走。

import { describe, expect, it } from 'vitest'
import { NEED_MOTION_MS, canExpressNeed, planForNeed } from '@core/needMotion'

const T0 = Date.UTC(2026, 10, 25, 12, 0, 0)
const ctx = (x: number, opts: { maxX?: number; interest?: { x: number; y: number } | null } = {}) => ({
  boundsWidth: 1920,
  maxX: opts.maxX ?? 1840,
  x,
  interestPoint: opts.interest ?? null,
})

describe('需求 → 动作计划', () => {
  it('饿了会走到最近的边缘', () => {
    // 在左半屏 → 去左边
    expect(planForNeed('hungry', ctx(300), T0)?.plan).toEqual({ kind: 'seek', x: 8 })
    // 在右半屏 → 去右边
    expect(planForNeed('hungry', ctx(1500), T0)?.plan).toEqual({ kind: 'seek', x: 1832 })
  })

  it('已经在边上时不去原地打转', () => {
    const p = planForNeed('hungry', ctx(8), T0)
    expect(p?.plan.kind).toBe('stretch')
  })

  it('无聊会走开一段（不是原地不动）', () => {
    const p = planForNeed('bored', ctx(200), T0)
    expect(p?.plan.kind).toBe('seek')
    if (p && p.plan.kind === 'seek') expect(p.plan.x).toBeGreaterThan(200)
  })

  it('想你会走到鼠标附近', () => {
    const p = planForNeed('lonely', ctx(100, { interest: { x: 900, y: 400 } }), T0)
    expect(p?.plan).toEqual({ kind: 'seek', x: 900 })
  })

  it('没有鼠标信息时「想你」不用身体表达（不瞎走）', () => {
    expect(planForNeed('lonely', ctx(100, { interest: null }), T0)).toBeNull()
  })

  it('目标坐标永远落在屏幕内', () => {
    for (const x of [0, 5, 500, 1835, 1840]) {
      for (const kind of ['hungry', 'bored'] as const) {
        const p = planForNeed(kind, ctx(x), T0)
        if (p && p.plan.kind === 'seek') {
          expect(p.plan.x).toBeGreaterThanOrEqual(0)
          expect(p.plan.x).toBeLessThanOrEqual(1840)
        }
      }
    }
  })

  it('同一种需求在同一位置给出同一个目标（可复现）', () => {
    const a = planForNeed('bored', ctx(600), T0)
    const b = planForNeed('bored', ctx(600), T0)
    expect(a).toEqual(b)
  })

  it('时长为固定的身体表达窗口', () => {
    expect(planForNeed('hungry', ctx(300), T0)?.until).toBe(T0 + NEED_MOTION_MS)
  })
})

describe('什么时候可以表达', () => {
  const base = { mood: 'neutral', canWander: true, now: T0, activeUntil: T0 + 60_000 }

  it('正常醒着时可以', () => {
    expect(canExpressNeed(base)).toBe(true)
  })

  it('睡觉 / 打盹时不表达', () => {
    expect(canExpressNeed({ ...base, mood: 'sleep' })).toBe(false)
    expect(canExpressNeed({ ...base, mood: 'doze' })).toBe(false)
  })

  it('不能自主活动时（菜单打开 / 被拖动）不表达', () => {
    expect(canExpressNeed({ ...base, canWander: false })).toBe(false)
  })

  it('需求已过期就不再演', () => {
    expect(canExpressNeed({ ...base, now: T0 + 60_001 })).toBe(false)
  })
})
