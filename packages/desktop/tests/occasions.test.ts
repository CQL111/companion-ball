// tests/occasions.test.ts - P1.5 事件记忆
// 按 docs/OCCASIONS.md 第九节的验收清单逐条写。

import { describe, expect, it } from 'vitest'
import {
  MAX_UPCOMING,
  addOccasion,
  approachLine,
  clearOccasions,
  daysBetween,
  diaryLineFor,
  dismissOccasion,
  extractOccasion,
  followupLine,
  markBeat,
  nextBeat,
  parseDate,
  tickOccasions,
  toDateKey,
  type Occasion,
} from '@core/occasions'

// 固定「现在」：2026-11-25（周三）上午 10 点
const NOW = new Date(2026, 10, 25, 10, 0, 0).getTime()
const day = (offset: number) => {
  const d = new Date(2026, 10, 25 + offset)
  return toDateKey(d)
}

describe('抽取：事件词 + 日期词', () => {
  it('「我下周三要面试」→ 下周三', () => {
    const r = extractOccasion('我下周三要面试', NOW)
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('interview')
    expect(r!.date).toBe(day(7)) // 本周三 + 7 天
    expect(r!.certainty).toBe('vague')
  })

  it('「明天体检」→ 明天', () => {
    const r = extractOccasion('明天要去体检', NOW)
    expect(r!.kind).toBe('appointment')
    expect(r!.date).toBe(day(1))
    expect(r!.certainty).toBe('day')
  })

  it('「12月3日答辩」→ 明确日期', () => {
    const r = extractOccasion('12月3日要答辩', NOW)
    expect(r!.kind).toBe('other')
    expect(r!.date).toBe('2026-12-03')
    expect(r!.certainty).toBe('day')
  })

  it('「3月5日」在12月说 → 取明年', () => {
    const r = extractOccasion('3月5日考试', NOW)
    expect(r!.date).toBe('2027-03-05')
  })

  it('只有事件没有日期 → 不抽（留给普通记忆）', () => {
    expect(extractOccasion('我最近在找工作', NOW)).toBeNull()
  })

  it('只有日期没有事件 → 不抽', () => {
    expect(extractOccasion('明天好累', NOW)).toBeNull()
  })

  it('否定 / 已完成不抽', () => {
    expect(extractOccasion('我上周面试完了', NOW)).toBeNull()
    expect(extractOccasion('考试取消了', NOW)).toBeNull()
    expect(extractOccasion('面试已经结束了', NOW)).toBeNull()
  })

  it('过去的日期不抽', () => {
    // 「昨天」不是未来的事
    expect(extractOccasion('昨天去体检了', NOW)).toBeNull()
  })

  it('保留用户原话', () => {
    const r = extractOccasion('我下周三下午要面字节', NOW)
    expect(r!.text).toBe('我下周三下午要面字节')
  })
})

describe('解析日期', () => {
  it('今天 / 明天 / 后天', () => {
    expect(parseDate('今天', NOW)!.date).toBe(day(0))
    expect(parseDate('明天', NOW)!.date).toBe(day(1))
    expect(parseDate('后天', NOW)!.date).toBe(day(2))
    expect(parseDate('大后天', NOW)!.date).toBe(day(3))
  })

  it('这周末 / 下周末', () => {
    const thisWeekend = parseDate('这周末', NOW)!
    expect(new Date(thisWeekend.date + 'T00:00:00').getDay()).toBe(6)
    const nextWeekend = parseDate('下周末', NOW)!
    expect(daysBetween(thisWeekend.date, nextWeekend.date)).toBe(7)
  })

  it('跨月：月底', () => {
    expect(parseDate('月底', NOW)!.date).toBe('2026-11-30')
  })

  it('跨年：12月30日说「1月2日」', () => {
    const dec = new Date(2026, 11, 30, 10).getTime()
    expect(parseDate('1月2日考试', dec)!.date).toBe('2027-01-02')
  })
})

describe('记住：合并与上限', () => {
  const mk = (date: string, kind: 'interview' | 'exam' = 'interview'): Occasion => ({
    id: `o_${date}`,
    text: `测试 ${date}`,
    kind,
    date,
    certainty: 'day',
    status: 'upcoming',
    createdAt: new Date(NOW).toISOString(),
  })

  it('同一天同类事件不重复记', () => {
    const first = addOccasion([], { text: '下周三面试', kind: 'interview', date: day(7), certainty: 'vague' }, { now: NOW })
    const second = addOccasion(
      first,
      { text: '又要面试了', kind: 'interview', date: day(7), certainty: 'vague' },
      { now: NOW },
    )
    expect(second.length).toBe(1)
  })

  it('同类不同日可以记', () => {
    const a = addOccasion([], { text: '明天面试', kind: 'interview', date: day(1), certainty: 'day' }, { now: NOW })
    const b = addOccasion(a, { text: '下周三面试', kind: 'interview', date: day(7), certainty: 'vague' }, { now: NOW })
    expect(b.length).toBe(2)
  })

  it(`上限 ${MAX_UPCOMING} 条，超出淘汰最远的`, () => {
    let list: Occasion[] = []
    for (let i = 1; i <= MAX_UPCOMING + 2; i++) {
      list = addOccasion(list, { text: `考试 ${i}`, kind: 'exam', date: day(i), certainty: 'day' }, { now: NOW })
    }
    expect(list.length).toBe(MAX_UPCOMING)
    // 最远的第 12 天那条应被淘汰，第 1 天的应还在
    expect(list.some((o) => o.date === day(MAX_UPCOMING + 2))).toBe(false)
    expect(list.some((o) => o.date === day(1))).toBe(true)
  })

  it('划掉后状态为 dismissed，不再触发', () => {
    const list = [mk(day(1))]
    const after = dismissOccasion(list, 'o_' + day(1))
    expect(after[0]!.status).toBe('dismissed')
    expect(nextBeat(after, NOW)).toBeNull()
  })

  it('关闭开关清空未完成条目', () => {
    const list = [mk(day(1)), mk(day(5), 'exam')]
    expect(clearOccasions(list).length).toBe(0)
  })
})

describe('状态机：upcoming → passed，30 天后清理', () => {
  const mk = (date: string): Occasion => ({
    id: 'o1',
    text: '考试',
    kind: 'exam',
    date,
    certainty: 'day',
    status: 'upcoming',
    createdAt: new Date(NOW).toISOString(),
  })

  it('日期过了 → passed', () => {
    const list = tickOccasions([mk('2026-11-20')], NOW)
    expect(list[0]!.status).toBe('passed')
  })

  it('30 天后的 passed 被清理', () => {
    const old = { ...mk('2026-10-01'), status: 'passed' as const }
    expect(tickOccasions([old], NOW).length).toBe(0)
  })

  it('未过期的 upcoming 不受影响', () => {
    const list = tickOccasions([mk(day(3))], NOW)
    expect(list[0]!.status).toBe('upcoming')
  })
})

describe('接住：三个节奏各只触发一次', () => {
  const at = (date: string): Occasion => ({
    id: 'o1',
    text: '面试',
    kind: 'interview',
    date,
    certainty: 'day',
    status: 'upcoming',
    createdAt: new Date(NOW).toISOString(),
  })

  it('T-1 提一句', () => {
    const p = nextBeat([at(day(1))], NOW)
    expect(p?.beat).toBe('approach')
    expect(p!.line).not.toMatch(/[0-9]/) // 不报数字
  })

  it('T-1 提过之后不再提', () => {
    const list = markBeat([at(day(1))], 'o1', 'approach', NOW)
    expect(nextBeat(list, NOW)).toBeNull()
  })

  it('当天返回 today beat（渲染层用身体动作）', () => {
    const p = nextBeat([at(day(0))], NOW)
    expect(p?.beat).toBe('today')
  })

  it('T+1 问一句结果', () => {
    const p = nextBeat([at(day(-1))], NOW)
    expect(p?.beat).toBe('followup')
  })

  it('T+1 问过之后不再问，也不追问', () => {
    const list = markBeat([at(day(-1))], 'o1', 'followup', NOW)
    expect(nextBeat(list, NOW)).toBeNull()
  })

  it('还没到 T-1 时不提', () => {
    expect(nextBeat([at(day(3))], NOW)).toBeNull()
  })

  it('台词用相对词，不出现天数', () => {
    const o = at(day(1))
    expect(approachLine(o)).toBe('快到你面试了。')
    expect(followupLine(o)).toBe('面试怎么样了？')
    for (const l of [approachLine(o), followupLine(o)]) expect(l).not.toMatch(/[0-9]/)
  })
})

describe('日记写法', () => {
  it('保留原话的分量，用「我会记得的」收尾', () => {
    const o: Occasion = {
      id: 'o1',
      text: '我下周三下午要面字节',
      kind: 'interview',
      date: day(7),
      certainty: 'vague',
      status: 'upcoming',
      createdAt: new Date(NOW).toISOString(),
    }
    const line = diaryLineFor(o)
    expect(line).toContain('下周三下午要面字节')
    expect(line).toContain('我会记得的')
    expect(line).not.toMatch(/[0-9]/)
  })
})
