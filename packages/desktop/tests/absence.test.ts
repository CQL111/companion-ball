// tests/absence.test.ts - P1 缺席日志
// 守三件事：确定性（同一段缺席永远同一句）、允许空白、不说数字。

import { describe, expect, it } from 'vitest'
import {
  ABSENCE_LONG_MS,
  ABSENCE_MIN_MS,
  ABSENCE_VERY_LONG_MS,
  bucketOf,
  buildAbsenceLines,
  describeAbsence,
  nightsBetween,
  returnTimeOf,
  seasonOf,
  shouldRecordAbsence,
} from '@core/absence'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

describe('缺席判定', () => {
  it('少于 8 小时不写（短暂离开是常态）', () => {
    expect(shouldRecordAbsence(7 * HOUR)).toBe(false)
    expect(shouldRecordAbsence(ABSENCE_MIN_MS)).toBe(true)
  })

  it('时长分档', () => {
    expect(bucketOf(9 * HOUR)).toBe('overnight')
    expect(bucketOf(ABSENCE_LONG_MS)).toBe('long')
    expect(bucketOf(ABSENCE_VERY_LONG_MS)).toBe('very-long')
  })

  it('回来时段的边界', () => {
    const at = (h: number) => new Date(2026, 10, 25, h, 0, 0).getTime()
    expect(returnTimeOf(at(0))).toBe('dawn')
    expect(returnTimeOf(at(5))).toBe('dawn')
    expect(returnTimeOf(at(6))).toBe('morning')
    expect(returnTimeOf(at(12))).toBe('afternoon')
    expect(returnTimeOf(at(18))).toBe('evening')
    expect(returnTimeOf(at(23))).toBe('night')
  })

  it('跨夜天数', () => {
    const start = new Date(2026, 10, 20, 22, 0, 0).getTime()
    expect(nightsBetween(start, new Date(2026, 10, 21, 10, 0, 0).getTime())).toBe(0)
    expect(nightsBetween(start, new Date(2026, 10, 22, 10, 0, 0).getTime())).toBe(1)
    expect(nightsBetween(start, new Date(2026, 10, 25, 10, 0, 0).getTime())).toBe(4)
  })

  it('季节', () => {
    expect(seasonOf(new Date(2026, 3, 1).getTime())).toBe('spring')
    expect(seasonOf(new Date(2026, 6, 1).getTime())).toBe('summer')
    expect(seasonOf(new Date(2026, 9, 1).getTime())).toBe('autumn')
    expect(seasonOf(new Date(2026, 11, 1).getTime())).toBe('winter')
  })
})

describe('生成日记行', () => {
  const start = new Date(2026, 10, 20, 22, 0, 0).getTime()
  const base = { awayStart: start, awayEnd: start + 9 * HOUR }

  it('少于 8 小时返回空数组（允许空白）', () => {
    expect(buildAbsenceLines({ input: { awayStart: start, awayEnd: start + 2 * HOUR } })).toEqual([])
  })

  it('8 小时以上至少有一句，且不超过 4 句', () => {
    const lines = buildAbsenceLines({ input: base })
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThanOrEqual(4)
  })

  it('同一段缺席永远生成同一句（确定性）', () => {
    const a = buildAbsenceLines({ input: base })
    const b = buildAbsenceLines({ input: base })
    expect(a).toEqual(b)
  })

  it('不同的缺席给出不同的话', () => {
    const a = buildAbsenceLines({ input: base })
    const b = buildAbsenceLines({ input: { ...base, awayStart: start + 30 * DAY } })
    expect(a).not.toEqual(b)
  })

  it('不出现任何数字（说感受不说数据）', () => {
    for (const ms of [9 * HOUR, 20 * HOUR, 2 * DAY, 10 * DAY]) {
      const lines = buildAbsenceLines({ input: { awayStart: start, awayEnd: start + ms } })
      for (const l of lines) {
        expect(l, `出现数字：${l}`).not.toMatch(/[0-9０-９]/)
      }
    }
  })

  it('不制造愧疚（不出现「你怎么才回来」这类指责）', () => {
    const bad = ['你怎么才回来', '你为什么不理我', '你把我忘了']
    for (const ms of [9 * HOUR, 2 * DAY, 10 * DAY]) {
      const lines = buildAbsenceLines({ input: { awayStart: start, awayEnd: start + ms } })
      for (const l of lines) {
        for (const b of bad) expect(l).not.toContain(b)
      }
    }
  })

  it('有天气时用天气，没天气用季节', () => {
    const rainy = buildAbsenceLines({ input: { ...base, weather: 'rain' } })
    expect(rainy.join('')).toMatch(/雨/)
    const clear = buildAbsenceLines({ input: { ...base, weather: 'none' } })
    expect(clear.join('')).not.toMatch(/雨|雪|雷/)
  })

  it('离开好几天会多一句', () => {
    const short = buildAbsenceLines({ input: { awayStart: start, awayEnd: start + 12 * HOUR } })
    const long = buildAbsenceLines({ input: { awayStart: start, awayEnd: start + 10 * DAY } })
    expect(long.length).toBeGreaterThanOrEqual(short.length)
    expect(long.length).toBeLessThanOrEqual(4)
  })
})

describe('describeAbsence', () => {
  it('返回结构可用于调试与「为什么写这句」', () => {
    const rec = describeAbsence({ awayStart: 0, awayEnd: 10 * DAY })
    expect(rec.bucket).toBe('very-long')
    expect(rec.nights).toBe(9)
    expect(['dawn', 'morning', 'afternoon', 'evening', 'night']).toContain(rec.returnTime)
  })
})
