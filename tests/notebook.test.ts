// tests/notebook.test.ts - 笔记本与人格卡单测
import { describe, expect, it } from 'vitest'
import {
  EMPTY_NOTEBOOK,
  buildDiaryLines,
  isEmptyDiary,
  recentEntries,
  toMarkdown,
  upsertDiary,
  type Notebook,
} from '@core/notebook'
import { buildMemoryBlock, buildSystemPrompt, composeSystemPrompt, DEFAULT_PERSONA } from '@core/persona'
import type { Memory } from '@core/memory'

const NOW = new Date('2026-11-20T21:00:00').getTime()
const mem = (text: string): Memory => ({ id: text, createdAt: '2026-11-01T00:00:00.000Z', text })

describe('buildDiaryLines', () => {
  it('说得越多，日记越具体（但不出现数字）', () => {
    const lines = buildDiaryLines({ now: NOW, userTurns: 8, interactions: 10, memories: [], talkedToday: true })
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('')).not.toMatch(/\d/)
  })

  it('没出现时写「几乎没出现」', () => {
    const lines = buildDiaryLines({ now: NOW, userTurns: 0, interactions: 0, memories: [], talkedToday: false })
    expect(lines[0]).toContain('几乎没出现')
  })

  it('有记忆时提到记得用户的事，且只用主题标签不用原文', () => {
    const lines = buildDiaryLines({
      now: NOW,
      userTurns: 2,
      interactions: 3,
      memories: [mem('用户住在杭州'), mem('用户在准备考试')],
      talkedToday: true,
    })
    const text = lines.join('')
    expect(text).toContain('记得')
    expect(text).not.toContain('杭州')
  })

  it('最多 4 句，且永不出现统计数字', () => {
    const lines = buildDiaryLines({ now: NOW, userTurns: 9, interactions: 20, memories: [mem('用户养了一只猫')], talkedToday: true })
    expect(lines.length).toBeLessThanOrEqual(4)
    expect(lines.join('')).not.toMatch(/\d/)
  })
})

describe('upsertDiary', () => {
  it('同一天只保留一条，后写的覆盖', () => {
    const a = upsertDiary(EMPTY_NOTEBOOK, NOW, ['第一版'])
    const b = upsertDiary(a, NOW + 1000, ['第二版'])
    expect(b.entries).toHaveLength(1)
    expect(b.entries[0]!.lines).toEqual(['第二版'])
  })

  it('空白日记不落盘', () => {
    const n = upsertDiary(EMPTY_NOTEBOOK, NOW, [])
    expect(n.entries).toHaveLength(0)
  })

  it('按日期倒序，且不修改入参', () => {
    const first = upsertDiary(EMPTY_NOTEBOOK, NOW - 86400000, ['昨天'])
    const second = upsertDiary(first, NOW, ['今天'])
    expect(second.entries.map((e) => e.date)).toEqual(['2026-11-20', '2026-11-19'])
    expect(first.entries).toHaveLength(1)
  })
})

describe('toMarkdown', () => {
  it('空笔记本给出占位，不报错', () => {
    expect(toMarkdown(EMPTY_NOTEBOOK)).toContain('还没有记录')
  })
  it('按日期倒序导出', () => {
    const n: Notebook = upsertDiary(upsertDiary(EMPTY_NOTEBOOK, NOW - 86400000, ['昨天']), NOW, ['今天'])
    const md = toMarkdown(n)
    expect(md.indexOf('## 2026-11-20')).toBeLessThan(md.indexOf('## 2026-11-19'))
    expect(md).toContain('- 今天')
  })
})

describe('recentEntries / isEmptyDiary', () => {
  it('限制返回条数', () => {
    let n: Notebook = EMPTY_NOTEBOOK
    for (let i = 0; i < 5; i++) n = upsertDiary(n, NOW - i * 86400000, [`第${i}天`])
    expect(recentEntries(n, 2)).toHaveLength(2)
  })
  it('空白判断', () => {
    expect(isEmptyDiary([' ', ''])).toBe(true)
    expect(isEmptyDiary(['有内容'])).toBe(false)
  })
})

describe('persona', () => {
  it('system prompt 包含物种、边界与说话规则', () => {
    const p = buildSystemPrompt()
    expect(p).toContain(DEFAULT_PERSONA.species)
    expect(p).toContain('不是助手')
    expect(p).toContain('不是心理咨询师')
    expect(p).toContain('说话规则')
  })

  it('有名字时注入名字，没名字时不出现「你叫」', () => {
    expect(buildSystemPrompt({ name: '团子' })).toContain('你叫团子')
    expect(buildSystemPrompt({ name: '   ' })).not.toContain('你叫')
  })

  it('记忆块为空时返回空串，组合 prompt 不出现空标题', () => {
    expect(buildMemoryBlock([])).toBe('')
    expect(composeSystemPrompt(undefined, [])).not.toContain('以下是关于用户的事实')
  })

  it('记忆块只列事实，不罗列原文以外的内容', () => {
    const block = buildMemoryBlock([{ text: '用户住在杭州' }])
    expect(block).toContain('- 用户住在杭州')
    expect(composeSystemPrompt('团子', [{ text: '用户住在杭州' }])).toContain('你叫团子')
  })
})
