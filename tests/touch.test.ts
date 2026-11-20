// tests/touch.test.ts - 触摸区域与注视单测
import { describe, expect, it } from 'vitest'
import { gazeToward, isPayingAttention, reactionFor, zoneAt, zonesFor } from '@core/touch'

describe('触摸区域', () => {
  it('顶部中线是头', () => {
    expect(zoneAt('front', 0.5, 0.25)).toBe('head')
  })
  it('底部是脚', () => {
    expect(zoneAt('front', 0.5, 0.92)).toBe('feet')
  })
  it('中间偏两侧是身体', () => {
    expect(zoneAt('front', 0.1, 0.7)).toBe('body')
  })
  it('超出角色范围返回 outside', () => {
    expect(zoneAt('front', -0.1, 0.5)).toBe('outside')
    expect(zoneAt('front', 1.2, 0.5)).toBe('outside')
  })
  it('侧影的头在右前侧', () => {
    expect(zoneAt('side', 0.8, 0.2)).toBe('head')
    expect(zoneAt('side', 0.15, 0.2)).toBe('body')
  })
  it('两个视角的区域定义都存在且合法', () => {
    for (const view of ['front', 'side'] as const) {
      const z = zonesFor(view)
      for (const box of [z.head, z.feet]) {
        expect(box.top).toBeGreaterThanOrEqual(0)
        expect(box.bottom).toBeLessThanOrEqual(1)
        expect(box.left).toBeLessThan(box.right)
      }
    }
  })
})

describe('区域反应', () => {
  it('摸头 → pat（最正面）', () => {
    expect(reactionFor('head').action).toBe('pat')
    expect(reactionFor('head').intensity).toBeGreaterThan(reactionFor('body').intensity)
  })
  it('挠脚 → grumble（不满）', () => {
    expect(reactionFor('feet').action).toBe('grumble')
  })
  it('戳身体 → tap（中性）', () => {
    expect(reactionFor('body').action).toBe('tap')
  })
})

describe('注视方向', () => {
  it('鼠标在右侧 → 向右看', () => {
    const g = gazeToward(100, 100, 300, 100)
    expect(g.x).toBeGreaterThan(0)
    expect(Math.abs(g.y)).toBeLessThan(0.01)
  })
  it('鼠标在下方 → 向下看', () => {
    const g = gazeToward(100, 100, 100, 300)
    expect(g.y).toBeGreaterThan(0)
  })
  it('鼠标准心重合 → 正前方', () => {
    expect(gazeToward(100, 100, 100, 100)).toEqual({ x: 0, y: 0 })
  })
  it('很远时偏移被截断到 1 以内', () => {
    const g = gazeToward(100, 100, 5000, 5000, 240)
    expect(Math.hypot(g.x, g.y)).toBeLessThanOrEqual(1.0001)
  })
  it('近距离偏移按比例更小', () => {
    const near = gazeToward(100, 100, 160, 100, 240)
    const far = gazeToward(100, 100, 340, 100, 240)
    expect(near.x).toBeLessThan(far.x)
  })
})

describe('注意力范围', () => {
  it('鼠标在阈值内才算注意我', () => {
    expect(isPayingAttention(100)).toBe(true)
    expect(isPayingAttention(400)).toBe(false)
  })
})
