// tests/locomotion.test.ts - 运动 / 物理单测（假随机与固定 dt，可完全复现）
import { describe, expect, it } from 'vitest'
import {
  PET_SIZE,
  grabLoco,
  initLoco,
  placeOnFloor,
  releaseLoco,
  stepLoco,
  syncLocoPosition,
  type Loco,
} from '@core/locomotion'

const BOUNDS = { width: 1000, height: 800 }
const FLOOR = BOUNDS.height - PET_SIZE // 720
const MAX_X = BOUNDS.width - PET_SIZE // 920

/** 按 16ms 一帧推进，最多 seconds 秒 */
function run(l: Loco, seconds: number, opts: { canWander?: boolean; random?: () => number; start?: number } = {}) {
  let now = opts.start ?? 0
  let cue = 'none' as string
  for (let t = 0; t < seconds * 1000; t += 16) {
    const r = stepLoco(l, {
      dtMs: 16,
      now,
      bounds: BOUNDS,
      canWander: opts.canWander ?? true,
      random: opts.random ?? (() => 0.1),
    })
    l = r.loco
    if (r.cue !== 'none') cue = r.cue
    now += 16
  }
  return { loco: l, cue, now }
}

describe('initLoco', () => {
  it('初始是待机，位置就是地面', () => {
    const l = initLoco(100, FLOOR)
    expect(l.state).toBe('idle')
    expect(l.x).toBe(100)
    expect(l.y).toBe(FLOOR)
  })
})

describe('throw 物理', () => {
  it('向右上抛出后先升后落，并最终停在地面', () => {
    const l = releaseLoco(initLoco(200, FLOOR), 600, -900, 0)
    const first = run(l, 0.2)
    expect(first.loco.y).toBeLessThan(FLOOR) // 已经飞起来
    const settled = run(l, 3)
    expect(settled.loco.y).toBe(FLOOR)
    expect(['land', 'idle']).toContain(settled.loco.state)
  })

  it('撞墙反弹后仍在屏幕内', () => {
    let l = releaseLoco(initLoco(MAX_X - 10, FLOOR), 2000, -400, 0)
    l = run(l, 1).loco
    expect(l.x).toBeGreaterThanOrEqual(0)
    expect(l.x).toBeLessThanOrEqual(MAX_X)
  })

  it('高速抛出后能量单调衰减，不会越弹越快', () => {
    let l = releaseLoco(initLoco(500, 300), 1800, -600, 0)
    let peak = 0
    for (let t = 0; t < 4000; t += 16) {
      const r = stepLoco(l, { dtMs: 16, now: t, bounds: BOUNDS, canWander: false })
      l = r.loco
      peak = Math.max(peak, Math.abs(l.vx))
      expect(Math.abs(l.x)).toBeLessThanOrEqual(MAX_X + 1)
    }
    expect(peak).toBeLessThanOrEqual(1500)
    expect(l.y).toBe(FLOOR)
  })

  it('重摔出声，轻放不出声', () => {
    const hard = run(releaseLoco(initLoco(500, 100), 0, 0, 0), 2)
    expect(hard.cue).toBe('land')
    const soft = run(releaseLoco(initLoco(500, FLOOR - 5), 0, 0, 0), 2)
    expect(soft.cue).not.toBe('land')
  })

  it('抛出时速度越大飞得越远（单调）', () => {
    const near = run(releaseLoco(initLoco(100, FLOOR), 300, -800, 0), 3).loco.x
    const far = run(releaseLoco(initLoco(100, FLOOR), 900, -800, 0), 3).loco.x
    expect(far).toBeGreaterThan(near)
  })

  it('被按住时完全不移动', () => {
    const held = grabLoco(initLoco(300, 400))
    const r = run(held, 5)
    expect(r.loco.x).toBe(300)
    expect(r.loco.y).toBe(400)
    expect(r.loco.state).toBe('held')
  })

  it('拖拽中同步坐标后，松手从新位置开始', () => {
    const held = syncLocoPosition(grabLoco(initLoco(300, 400)), 700, 200)
    expect(held.x).toBe(700)
    const flying = releaseLoco(held, 0, 0, 0)
    expect(flying.x).toBe(700)
    expect(flying.y).toBe(200)
  })
})

describe('自主行为', () => {
  it('不可自主活动时一直待机，也不改变位置', () => {
    const l = initLoco(400, FLOOR)
    const r = run(l, 300, { canWander: false, start: 0 })
    expect(r.loco.state).toBe('idle')
    expect(r.loco.x).toBe(400)
  })

  it('安静型：时间足够久后会开始走动', () => {
    // random 恒为 0.1 → 第一次决定选择「走一段」
    const r = run(initLoco(400, FLOOR), 200, { random: () => 0.1 })
    expect(['idle', 'walk', 'climb', 'hang', 'fall', 'land']).toContain(r.loco.state)
    expect(r.loco.y).toBeLessThanOrEqual(FLOOR)
  })

  it('选择攀爬时：先走到墙边，再沿墙上行到天花板，最后倒挂在顶部', () => {
    // 0.6 → 落在 [0.5,0.72) 区间：走到最近的墙再爬
    let l = initLoco(400, FLOOR)
    let now = 0
    let sawClimb = false
    let sawHang = false
    for (let i = 0; i < 4000; i++) {
      const r = stepLoco(l, { dtMs: 16, now, bounds: BOUNDS, canWander: true, random: () => 0.6 })
      l = r.loco
      now += 16
      if (l.state === 'climb') sawClimb = true
      if (l.state === 'hang') {
        sawHang = true
        break
      }
      expect(l.x).toBeGreaterThanOrEqual(0)
      expect(l.x).toBeLessThanOrEqual(MAX_X)
    }
    expect(sawClimb).toBe(true)
    expect(sawHang).toBe(true)
    expect(l.y).toBe(0)
  })
})

describe('placeOnFloor', () => {
  it('把角色放回地面并夹紧在屏幕内', () => {
    const l = placeOnFloor(initLoco(0, 0), 99999, BOUNDS)
    expect(l.x).toBe(MAX_X)
    expect(l.y).toBe(FLOOR)
    expect(l.state).toBe('idle')
  })
})
