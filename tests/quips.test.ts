// tests/quips.test.ts - 台词选择单测
import { describe, expect, it } from 'vitest'
import db from '../src/data/quips.json'
import {
  DEFAULT_COOLDOWN_MS,
  type QuipDatabase,
  pickBucket,
  pickQuip,
  rememberQuip,
  validateQuipDatabase,
  type QuipHistory,
} from '@core/quips'

const database = db as unknown as QuipDatabase
const T0 = new Date('2026-11-20T14:00:00').getTime()

describe('台词库结构', () => {
  it('每个 bucket 非空、无空白台词、有 fallback', () => {
    expect(validateQuipDatabase(database)).toEqual([])
  })

  it('台词总量落在 80–150 条（roadmap 目标）', () => {
    const total = Object.values(database.lines).reduce((n, list) => n + list.length, 0)
    expect(total).toBeGreaterThanOrEqual(80)
    expect(total).toBeLessThanOrEqual(150)
  })

  it('禁止长句：单句不超过 24 字', () => {
    for (const list of Object.values(database.lines)) {
      for (const line of list) expect(line.length).toBeLessThanOrEqual(24)
    }
  })
})

describe('pickBucket', () => {
  it('触发优先', () => {
    expect(pickBucket('morning', T0)).toBe('morning')
    expect(pickBucket('annoyed', T0)).toBe('annoyed')
    expect(pickBucket('dizzy', T0)).toBe('dizzy')
    expect(pickBucket('wake', T0)).toBe('wake')
  })
  it('拖动优先于触发', () => {
    expect(pickBucket('tap', T0, true)).toBe('drag')
  })
  it('深夜点击走 night', () => {
    const threeAm = new Date('2026-11-20T03:00:00').getTime()
    expect(pickBucket('tap', threeAm)).toBe('night')
  })
})

describe('pickQuip', () => {
  it('返回 bucket 内的一句', () => {
    const line = pickQuip(database, 'tap', {}, T0)
    expect(database.lines.tap).toContain(line)
  })

  it('冷却期内的台词不会被选中', () => {
    const history: QuipHistory = {}
    for (const line of database.lines.tap) history[line] = { at: T0 }
    const line = pickQuip(database, 'tap', history, T0 + 1000)
    // 全部在冷却中 → 回退到整池，仍然必须是合法台词
    expect(database.lines.tap).toContain(line)
  })

  it('优先选最久没说过的一句', () => {
    const [a, b, ...rest] = database.lines.tap
    const history: QuipHistory = { [a!]: { at: T0 }, [b!]: { at: T0 + 1000 } }
    for (const line of rest) history[line] = { at: T0 + 2000 }
    const line = pickQuip(database, 'tap', history, T0 + DEFAULT_COOLDOWN_MS + 5000, { random: () => 0 })
    expect(line).toBe(a)
  })

  it('从未说过的台词优先于说过的', () => {
    const [a, b] = database.lines.tap
    const line = pickQuip(database, 'tap', { [a!]: { at: T0 } }, T0 + 1, { random: () => 0 })
    expect(line).not.toBe(a)
    expect(database.lines.tap).toContain(line)
    expect(line).toBe(b)
  })
})

describe('rememberQuip', () => {
  it('记录时间并裁剪历史', () => {
    let h: QuipHistory = {}
    for (let i = 0; i < 250; i++) h = rememberQuip(h, `line-${i}`, T0 + i)
    expect(Object.keys(h).length).toBeLessThanOrEqual(200)
    expect(h['line-249']).toBeTruthy()
    expect(h['line-0']).toBeUndefined()
  })
})
