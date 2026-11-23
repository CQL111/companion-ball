// tests/locomotion.s45.test.ts - S4.5：跟鼠标、扒边缘、自己找地方睡
import { describe, expect, it } from 'vitest'
import {
  PERCH_SNAP,
  PET_SIZE,
  grabLoco,
  initLoco,
  releaseLoco,
  stepLoco,
  syncLocoPosition,
  type Loco,
} from '@core/locomotion'

const BOUNDS = { width: 1000, height: 800 }
const FLOOR = BOUNDS.height - PET_SIZE
const MAX_X = BOUNDS.width - PET_SIZE
const MIN = 60 * 1000

function step(l: Loco, now: number, opts: Partial<Parameters<typeof stepLoco>[1]> = {}) {
  return stepLoco(l, {
    dtMs: 16,
    now,
    bounds: BOUNDS,
    canWander: true,
    random: () => 0.1,
    ...opts,
  })
}

describe('跟鼠标（seek）', () => {
  it('鼠标停在某处会走过去', () => {
    // 让 nextDecisionAt 已过
    const l: Loco = { ...initLoco(100, FLOOR), nextDecisionAt: 0, nextSeekAt: 0 }
    const r = step(l, 1000, { interestPoint: { x: 700, y: FLOOR } })
    expect(r.loco.state).toBe('walk')
    expect(r.loco.plan?.kind).toBe('seek')
    expect(r.loco.facing).toBe(1)
  })

  it('走过去有冷却：刚追过就不再追', () => {
    const l: Loco = { ...initLoco(100, FLOOR), nextDecisionAt: 0, nextSeekAt: 2000 }
    const r = step(l, 1000, { interestPoint: { x: 700, y: FLOOR } })
    expect(r.loco.plan?.kind).not.toBe('seek')
  })

  it('跟鼠标时会真的走过去（位置要变化）', () => {
    let l: Loco = { ...initLoco(100, FLOOR), nextDecisionAt: 0, nextSeekAt: 0 }
    const start = l.x
    for (let t = 1000; t < 20_000; t += 16) {
      l = step(l, t, { interestPoint: { x: 700, y: FLOOR } }).loco
      // 只推进一小段就够验证方向
      if (l.plan?.kind === 'seek' && l.x > start + 50) break
    }
    expect(l.x).toBeGreaterThan(start + 50)
  })

  it('目标太近就不追（仍可自己溜达，但不该是 seek）', () => {
    const l: Loco = { ...initLoco(500, FLOOR), nextDecisionAt: 0, nextSeekAt: 0 }
    const r = step(l, 1000, { interestPoint: { x: 520, y: FLOOR } })
    expect(r.loco.plan?.kind).not.toBe('seek')
    // 冷却被推后，避免每帧重新判断
    expect(r.loco.nextSeekAt).toBeGreaterThan(1000)
  })

  it('目标超出屏幕会被夹紧', () => {
    const l: Loco = { ...initLoco(0, FLOOR), nextDecisionAt: 0, nextSeekAt: 0 }
    const r = step(l, 1000, { interestPoint: { x: 99999, y: FLOOR } })
    const plan = r.loco.plan
    if (plan?.kind === 'seek') expect(plan.x).toBeLessThanOrEqual(MAX_X)
  })
})

describe('拖到边缘扒住（perch）', () => {
  it('贴着左边缘慢速放下 → 扒住而不是掉下去', () => {
    const held = syncLocoPosition(grabLoco(initLoco(5, 300)), 5, 300)
    const r = releaseLoco(held, 0, 0, 1000, BOUNDS)
    expect(r.state).toBe('perch')
    expect(r.x).toBe(0)
  })

  it('贴着右边缘慢速放下 → 扒住', () => {
    const held = syncLocoPosition(grabLoco(initLoco(MAX_X - 4, 300)), MAX_X - 4, 300)
    const r = releaseLoco(held, 0, 0, 1000, BOUNDS)
    expect(r.state).toBe('perch')
    expect(r.x).toBe(MAX_X)
  })

  it('屏幕中间松手 → 正常掉落', () => {
    const held = syncLocoPosition(grabLoco(initLoco(500, 300)), 500, 300)
    const r = releaseLoco(held, 0, 0, 1000, BOUNDS)
    expect(r.state).toBe('fall')
  })

  it('贴边但甩得很快 → 不扒住（惯性优先）', () => {
    const held = syncLocoPosition(grabLoco(initLoco(5, 300)), 5, 300)
    const r = releaseLoco(held, 900, -300, 1000, BOUNDS)
    expect(r.state).toBe('fall')
  })

  it('扒住一段时间后自己松手掉下去', () => {
    const held = syncLocoPosition(grabLoco(initLoco(2, 300)), 2, 300)
    let l = releaseLoco(held, 0, 0, 1000, BOUNDS)
    expect(l.state).toBe('perch')
    // 15 秒后
    const r = step(l, 1000 + 15_000)
    expect(r.loco.state).toBe('fall')
  })

  it('只点一下（没拖动）不会扒住', () => {
    const held = syncLocoPosition(grabLoco(initLoco(2, 300)), 2, 300)
    const r = releaseLoco(held, 0, 0, 1000, BOUNDS, false)
    expect(r.state).not.toBe('perch')
  })

  it('PERCH_SNAP 是有限的正数', () => {
    expect(PERCH_SNAP).toBeGreaterThan(0)
    expect(PERCH_SNAP).toBeLessThan(50)
  })
})

describe('自己找地方睡（snooze）', () => {
  it('困了会真的走过去（位置要变化，不只是状态）', () => {
    let l: Loco = { ...initLoco(500, FLOOR), nextDecisionAt: 0 }
    const start = l.x
    for (let t = 1000; t < 20_000; t += 16) l = step(l, t, { sleepy: true }).loco
    // 500 → 中间，应该朝某个角落移动了明显距离
    expect(Math.abs(l.x - start)).toBeGreaterThan(100)
  })

  it('困了会往最近的角落走', () => {
    const l: Loco = { ...initLoco(200, FLOOR), nextDecisionAt: 0 }
    const r = step(l, 1000, { sleepy: true })
    expect(r.loco.state).toBe('walk')
    expect(r.loco.plan?.kind).toBe('snooze')
    // 左边更近
    expect((r.loco.plan as { x: number }).x).toBe(0)
  })

  it('已经在角落就直接趴下', () => {
    const l: Loco = { ...initLoco(0, FLOOR), nextDecisionAt: 0 }
    const r = step(l, 1000, { sleepy: true })
    expect(r.loco.state).toBe('snooze')
  })

  it('趴下后不自主活动（位置不变）', () => {
    let l: Loco = { ...initLoco(0, FLOOR), nextDecisionAt: 0 }
    l = step(l, 1000, { sleepy: true }).loco
    const before = l.x
    for (let t = 2000; t < 60_000; t += 1000) l = step(l, t, { sleepy: true }).loco
    expect(l.x).toBe(before)
    expect(l.state).toBe('snooze')
  })

  it('醒了会回到待机', () => {
    let l: Loco = { ...initLoco(0, FLOOR), nextDecisionAt: 0 }
    l = step(l, 1000, { sleepy: true }).loco
    const r = step(l, 2000, { sleepy: false })
    expect(r.loco.state).toBe('idle')
  })
})

describe('回归：原有行为不受影响', () => {
  it('不可自主活动时仍待机', () => {
    const l = initLoco(400, FLOOR)
    const r = step(l, 300 * MIN, { canWander: false })
    expect(r.loco.state).toBe('idle')
  })

  it('甩出去仍然能飞出并落地', () => {
    let l = releaseLoco(initLoco(400, FLOOR), 600, -900, 0)
    for (let t = 0; t < 4000; t += 16) l = step(l, t, { canWander: false }).loco
    expect(l.y).toBe(FLOOR)
  })
})
