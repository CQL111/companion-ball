// tests/memory.test.ts - 长期记忆单测
import type { AgentMessage } from '@core/types'
import { describe, expect, it } from 'vitest'
import {
  MAX_MEMORIES,
  buildExtractMessages,
  isDuplicate,
  memoryTopics,
  mergeMemories,
  parseExtractedFacts,
  removeMemory,
  shouldExtract,
  type Memory,
} from '@core/memory'

const mem = (text: string, createdAt: string, id = text): Memory => ({ id, createdAt, text })

describe('parseExtractedFacts', () => {
  it('解析 {"facts":[...]}', () => {
    expect(parseExtractedFacts('{"facts":["用户住在杭州","用户在准备考试"]}')).toEqual(['用户住在杭州', '用户在准备考试'])
  })
  it('容忍前后废话与数组形式', () => {
    expect(parseExtractedFacts('好的：{"facts":["用户养了一只猫"]} 以上')).toEqual(['用户养了一只猫'])
    expect(parseExtractedFacts('["用户喜欢下雨天"]')).toEqual(['用户喜欢下雨天'])
  })
  it('非 JSON 时逐行兜底', () => {
    expect(parseExtractedFacts('- 用户住在杭州\n* 用户养了一只猫\n1. 用户最近在复习')).toEqual([
      '用户住在杭州',
      '用户养了一只猫',
      '用户最近在复习',
    ])
  })
  it('过滤空串与超长条目，并限制每轮上限', () => {
    const long = 'x'.repeat(200)
    const out = parseExtractedFacts(JSON.stringify({ facts: ['  ', long, '用户喜欢猫', '用户住在杭州', 'a', 'b', 'c'] }))
    expect(out).toContain('用户喜欢猫')
    expect(out).not.toContain(long)
    expect(out.length).toBeLessThanOrEqual(5)
  })
  it('空输入返回空数组', () => {
    expect(parseExtractedFacts('')).toEqual([])
    expect(parseExtractedFacts('{}')).toEqual([])
  })
})

describe('isDuplicate', () => {
  it('完全相同视为重复（忽略空白与大小写）', () => {
    expect(isDuplicate('用户住在杭州', '用户住在 杭州')).toBe(true)
  })
  it('包含关系且都够长视为重复', () => {
    expect(isDuplicate('用户住在杭州', '用户住在杭州西湖区')).toBe(true)
  })
  it('过短的不做包含判断', () => {
    expect(isDuplicate('猫', '猫粮')).toBe(false)
  })
})

describe('mergeMemories', () => {
  it('去重后追加，并带上时间/id', () => {
    const existing = [mem('用户住在杭州', '2026-11-01T00:00:00.000Z')]
    const out = mergeMemories(existing, ['用户住在杭州', '用户养了一只猫'], {
      now: '2026-11-20T00:00:00.000Z',
      makeId: () => 'm_new',
    })
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ id: 'm_new', createdAt: '2026-11-20T00:00:00.000Z', text: '用户养了一只猫' })
  })

  it('超过上限时淘汰最旧的', () => {
    const existing = Array.from({ length: MAX_MEMORIES }, (_, i) =>
      mem(`事实${i}`, new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), `m${i}`),
    )
    const out = mergeMemories(existing, ['新的记忆'], { now: '2026-12-31T00:00:00.000Z', makeId: () => 'm_new' })
    expect(out).toHaveLength(MAX_MEMORIES)
    expect(out.some((m) => m.text === '事实0')).toBe(false)
    expect(out.some((m) => m.text === '新的记忆')).toBe(true)
  })

  it('不修改入参', () => {
    const existing = [mem('用户住在杭州', '2026-11-01T00:00:00.000Z')]
    const snapshot = JSON.stringify(existing)
    mergeMemories(existing, ['用户养了一只猫'])
    expect(JSON.stringify(existing)).toBe(snapshot)
  })
})

describe('removeMemory', () => {
  it('按 id 删除并返回新数组', () => {
    const list = [mem('a', '2026-01-01T00:00:00.000Z', '1'), mem('b', '2026-01-02T00:00:00.000Z', '2')]
    const out = removeMemory(list, '1')
    expect(out).toHaveLength(1)
    expect(list).toHaveLength(2)
  })
})

describe('shouldExtract', () => {
  it('太短的闲聊不抽取', () => {
    expect(shouldExtract([{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在' }])).toBe(false)
  })
  it('内容足够时抽取', () => {
    expect(
      shouldExtract([{ role: 'user', content: '我最近在杭州准备一个很重要的考试，每天复习到很晚' }]),
    ).toBe(true)
  })
  it('多轮对话即使短也值得看一眼', () => {
    const msgs: AgentMessage[] = Array.from({ length: 3 }, () => ({ role: 'user', content: '嗯' }))
    expect(shouldExtract(msgs)).toBe(true)
  })
})

describe('buildExtractMessages', () => {
  it('只取最近 8 条 user/assistant 并带上系统提示', () => {
    const msgs: AgentMessage[] = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `第${i}句` }))
    const out = buildExtractMessages({ messages: msgs })
    expect(out[0]!.role).toBe('system')
    expect(out[1]!.content).not.toContain('第0句')
    expect(out[1]!.content).toContain('第29句')
  })
})

describe('memoryTopics', () => {
  it('按关键词归类，不暴露原文', () => {
    const topics = memoryTopics([mem('用户住在杭州', '2026-01-01T00:00:00.000Z'), mem('用户在准备考试', '2026-01-01T00:00:00.000Z')])
    expect(topics).toContain('住处')
    expect(topics).toContain('学习')
  })
})
