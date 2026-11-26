// tests/notebook.test.ts - 笔记本与人格卡单测
import { describe, expect, it } from 'vitest'
import {
  EMPTY_NOTEBOOK,
  MARGIN_MAX_CHARS,
  buildDiaryLines,
  eraseMargin,
  isEmptyDiary,
  normalizeMargin,
  recentEntries,
  toMarkdown,
  upsertDiary,
  writeMargin,
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

describe('缺席日记不会被模板覆盖（P1）', () => {
  const now = new Date(2026, 10, 25, 9, 0, 0).getTime()
  const absenceLines = ['早上好。我等你等了一整夜。', '你走后我一直趴着，没怎么动。']

  it('写成 source=absence 的条目', () => {
    const nb = upsertDiary(EMPTY_NOTEBOOK, now, absenceLines, 'absence')
    expect(nb.entries[0]?.source).toBe('absence')
    expect(nb.entries[0]?.lines).toEqual(absenceLines)
  })

  it('之后的模板日记不能把它整段覆盖，而是接在后面', () => {
    let nb = upsertDiary(EMPTY_NOTEBOOK, now, absenceLines, 'absence')
    nb = upsertDiary(nb, now, ['今天你说了不少话。', '就这样待着，也挺好。'], 'template')
    const entry = nb.entries[0]!
    // 缺席内容仍在开头
    expect(entry.lines.slice(0, 2)).toEqual(absenceLines)
    // 模板内容接在后面
    expect(entry.lines).toContain('今天你说了不少话。')
    // 总数不超过 4 句
    expect(entry.lines.length).toBeLessThanOrEqual(4)
    // 来源仍是缺席（真实事件优先）
    expect(entry.source).toBe('absence')
  })

  it('没有缺席的那天，模板日记照常覆盖', () => {
    let nb = upsertDiary(EMPTY_NOTEBOOK, now, ['早上很安静。'], 'template')
    nb = upsertDiary(nb, now, ['今天你说了不少话。'], 'template')
    expect(nb.entries[0]?.lines).toEqual(['今天你说了不少话。'])
    expect(nb.entries[0]?.source).toBe('template')
  })

  it('缺省来源仍是 template（向后兼容）', () => {
    const nb = upsertDiary(EMPTY_NOTEBOOK, now, ['今天很安静。'])
    expect(nb.entries[0]?.source).toBe('template')
  })
})

describe('页边一句话（P2）', () => {
  const DAY = '2026-11-20'

  it('规范化：折成一行、去首尾空白', () => {
    expect(normalizeMargin('  今天有点累 \n 但还是想说话  ')).toBe('今天有点累 但还是想说话')
  })

  it('规范化：空 / 全空白 → null（不留下空句子）', () => {
    expect(normalizeMargin('')).toBe(null)
    expect(normalizeMargin('   \n\t  ')).toBe(null)
  })

  it('规范化：超长截断，不报错', () => {
    const long = '好'.repeat(MARGIN_MAX_CHARS + 40)
    expect(normalizeMargin(long)?.length).toBe(MARGIN_MAX_CHARS)
  })

  it('写在有日记的一页上', () => {
    let nb = upsertDiary(EMPTY_NOTEBOOK, NOW, ['今天很安静。'])
    nb = writeMargin(nb, DAY, '其实我今天有点难过', NOW)!
    expect(nb.entries[0]?.margin?.text).toBe('其实我今天有点难过')
    // 猫的日记不受影响
    expect(nb.entries[0]?.lines).toEqual(['今天很安静。'])
  })

  // 最关键的一条：猫每天都会重算日记，你的话不能被冲掉
  it('猫重算日记后，页边一句话仍在', () => {
    let nb = upsertDiary(EMPTY_NOTEBOOK, NOW, ['今天很安静。'])
    nb = writeMargin(nb, DAY, '我今天有点难过', NOW)!
    // 同一天日记被重算（模板覆盖）
    nb = upsertDiary(nb, NOW, ['今天你说了不少话。'], 'template')
    expect(nb.entries[0]?.lines).toEqual(['今天你说了不少话。'])
    expect(nb.entries[0]?.margin?.text).toBe('我今天有点难过')
  })

  it('缺席日记并入模板时，页边一句话仍在', () => {
    let nb = upsertDiary(EMPTY_NOTEBOOK, NOW, ['你走了很久。'], 'absence')
    nb = writeMargin(nb, DAY, '我出差去了', NOW)!
    nb = upsertDiary(nb, NOW, ['今天你说了不少话。'], 'template')
    expect(nb.entries[0]?.source).toBe('absence')
    expect(nb.entries[0]?.margin?.text).toBe('我出差去了')
  })

  // 空白页：猫今天没话说，但用户想留一句——这一页必须存在
  it('可以在「猫没说话」的空白页上留一句', () => {
    const nb = writeMargin(EMPTY_NOTEBOOK, DAY, '今天什么都没做', NOW)!
    expect(nb.entries).toHaveLength(1)
    expect(nb.entries[0]?.lines).toEqual([])
    expect(nb.entries[0]?.margin?.text).toBe('今天什么都没做')
  })

  it('空白页上的话不会被「空白不落盘」的规则吞掉', () => {
    let nb = writeMargin(EMPTY_NOTEBOOK, DAY, '今天什么都没做', NOW)!
    // 之后某个流程以空行重算这一页
    nb = upsertDiary(nb, NOW, [], 'template')
    expect(nb.entries[0]?.margin?.text).toBe('今天什么都没做')
  })

  it('一页只有一句：再写会覆盖上一句', () => {
    let nb = writeMargin(EMPTY_NOTEBOOK, DAY, '第一句', NOW)!
    nb = writeMargin(nb, DAY, '第二句', NOW)!
    expect(nb.entries[0]?.margin?.text).toBe('第二句')
    expect(nb.entries.filter((e) => e.date === DAY)).toHaveLength(1)
  })

  it('空内容不写（返回 null）', () => {
    expect(writeMargin(EMPTY_NOTEBOOK, DAY, '   ', NOW)).toBe(null)
  })

  it('可以在这之前的那一页补一句', () => {
    let nb = upsertDiary(EMPTY_NOTEBOOK, NOW - 3 * 86400_000, ['三天前。'])
    const old = nb.entries[0]!.date
    nb = writeMargin(nb, old, '那天其实是我生日', NOW)!
    expect(nb.entries[0]?.margin?.text).toBe('那天其实是我生日')
    // 写下这句的日期是今天，但挂在旧的那一页
    expect(nb.entries[0]?.date).toBe(old)
    expect(nb.entries[0]?.margin?.date).toBe('2026-11-20')
  })

  it('抹掉后彻底消失（不软删除）', () => {
    let nb = writeMargin(EMPTY_NOTEBOOK, DAY, '说了就后悔', NOW)!
    nb = eraseMargin(nb, DAY)!
    expect(nb.entries[0]?.margin).toBe(undefined)
  })

  it('抹掉没有页边话的一页 → null', () => {
    const nb = upsertDiary(EMPTY_NOTEBOOK, NOW, ['今天很安静。'])
    expect(eraseMargin(nb, DAY)).toBe(null)
  })

  it('导出 Markdown 带上页边一句话', () => {
    let nb = upsertDiary(EMPTY_NOTEBOOK, NOW, ['今天很安静。'])
    nb = writeMargin(nb, DAY, '我留了一句', NOW)!
    const md = toMarkdown(nb)
    expect(md).toContain('我留了一句')
    expect(md).toContain('页边')
  })
})
