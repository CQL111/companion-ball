// tests/agent.test.ts - core/agent 单元测试（纯 node，无 Electron）
import { describe, expect, it } from 'vitest'
import * as agent from '@core/agent'
import type { AgentMessage } from '@shared/types'

describe('agent 基础契约', () => {
  it('系统提示非空且是陪伴型角色', () => {
    expect(agent.SYSTEM_PROMPT.length).toBeGreaterThan(0)
    expect(agent.SYSTEM_PROMPT).toContain('团子猫')
  })

  it('S0 不带工具', () => {
    expect(Array.isArray(agent.TOOLS)).toBe(true)
    expect(agent.TOOLS.length).toBe(0)
  })

  it('保留的对话轮数 >= 4', () => {
    expect(agent.HISTORY_TURNS).toBeGreaterThanOrEqual(4)
  })
})

describe('parseArgs', () => {
  it('解析 JSON', () => {
    expect(JSON.stringify(agent.parseArgs('{"a":1}'))).toBe('{"a":1}')
  })
  it('非法输入返回空对象', () => {
    expect(JSON.stringify(agent.parseArgs('not json'))).toBe('{}')
  })
  it('null 返回空对象', () => {
    expect(JSON.stringify(agent.parseArgs(null))).toBe('{}')
  })
})

describe('executeTool', () => {
  it('S0 没有可执行工具', () => {
    const tr = agent.executeTool('anything', {}, {})
    expect(tr.ok).toBe(false)
    expect(tr.error).toBe('NO_TOOLS')
  })
})

describe('publicHistory', () => {
  it('只保留有内容的 user/assistant', () => {
    const hist = agent.publicHistory([
      { role: 'system', content: 'x' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '嗨' },
      { role: 'tool', content: 'y' },
      { role: 'assistant', content: '' },
    ])
    expect(hist).toHaveLength(2)
    expect(hist[0]!.role).toBe('user')
    expect(hist[1]!.role).toBe('assistant')
  })
})

describe('trimByUserTurns', () => {
  const long: AgentMessage[] = []
  for (let i = 0; i < 20; i++) {
    long.push({ role: 'user', content: 'u' + i })
    long.push({ role: 'assistant', content: 'a' + i })
  }

  it('裁到 8 个用户轮', () => {
    const trimmed = agent.trimByUserTurns(long, 8)
    expect(trimmed.filter((m) => m.role === 'user')).toHaveLength(8)
  })
  it('裁掉最早的用户轮', () => {
    const trimmed = agent.trimByUserTurns(long, 8)
    expect(trimmed[0]!.content).toBe('u12')
  })
  it('未超限不裁剪', () => {
    expect(agent.trimByUserTurns(long, 50)).toHaveLength(long.length)
  })
})

describe('emptyAgentChat', () => {
  it('空会话结构正确', () => {
    const empty = agent.emptyAgentChat()
    expect(empty.messages).toEqual([])
    expect(empty.updatedAt).toBe(0)
  })
})

describe('runAgent', () => {
  const fakeCallLLM = async (): Promise<{ content: string; usage: { total_tokens: number } }> => ({
    content: '我在呢。',
    usage: { total_tokens: 12 },
  })

  it('返回模型文本并累计用量', async () => {
    const calls: any[] = []
    const spy = async (opts: any): Promise<any> => {
      calls.push(opts)
      return fakeCallLLM()
    }
    const res = await agent.runAgent({
      history: [],
      userQuery: '你在吗',
      aiConfig: { baseUrl: 'http://x', token: 't', model: 'm' },
      ctx: {},
      callLLM: spy,
    })
    expect(res.text).toBe('我在呢。')
    expect(res.usage.total_tokens).toBe(12)
    expect(res.history).toHaveLength(2)
    expect(calls[0].messages[0].role).toBe('system')
    expect(calls[0].messages[1].content).toBe('你在吗')
  })

  it('空问题抛 EMPTY_QUERY', async () => {
    await expect(
      agent.runAgent({ userQuery: '  ', aiConfig: { baseUrl: '', token: 't', model: 'm' }, callLLM: fakeCallLLM }),
    ).rejects.toThrow('EMPTY_QUERY')
  })

  it('无 token 抛 NO_TOKEN', async () => {
    await expect(
      agent.runAgent({ userQuery: 'x', aiConfig: { baseUrl: '', token: '', model: 'm' }, callLLM: fakeCallLLM }),
    ).rejects.toThrow('NO_TOKEN')
  })
})
