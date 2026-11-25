// agent.ts - 桌面陪伴 AI 对话循环（领域层，零平台依赖）
// 不依赖 Electron；callLLM 由调用方注入，便于纯 node / vitest 测试与手机端复用。

import type { AgentMessage, AiConfig } from './types'
import type { Logger } from './logger-types'

const MAX_STEPS = 6
const RESULT_MAX = 2400
export const HISTORY_TURNS = 8 // 按用户轮次裁，不是按 raw message 条数

export const SYSTEM_PROMPT =
  '你是常驻用户桌面的小团子猫，一个陪伴型角色，不是助手。' +
  '语气温暖、轻松、简短，像身边的朋友：关心用户的状态，但不说教、不总结用户的话。' +
  '不装成算命先生、不做心理诊断、不编造事实；不知道就坦白说不知道，再顺着话题聊下去。' +
  '每次回答尽量 1-3 句，不要长篇大论，也不要重复用户的话。'

export const TOOLS: unknown[] = []
export const TOOL_LABELS: Record<string, string> = {}

export interface LlmUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface ToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
  name?: string
  arguments?: string
}

export interface CallLlmResult {
  content?: string
  tool_calls?: ToolCall[]
  finish_reason?: string
  usage?: LlmUsage
  model?: string
}

export type CallLlm = (opts: {
  baseUrl: string
  token: string
  model: string
  messages: AgentMessage[]
  tools?: unknown[]
  jsonMode?: boolean
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}) => Promise<CallLlmResult>

export interface ToolOutcome {
  ok: boolean
  error?: string
  [key: string]: unknown
}

export interface RunAgentOptions {
  history?: AgentMessage[]
  userQuery: string
  aiConfig: AiConfig
  ctx?: Record<string, unknown>
  logger?: Logger
  /** S2 起由 persona.composeSystemPrompt 生成（人格 + 记忆）；缺省用内置 SYSTEM_PROMPT */
  systemPrompt?: string
  callLLM: CallLlm
  onProgress?: (info: { tool: string; label: string }) => void
}

export interface RunAgentResult {
  text: string
  toolsUsed: string[]
  usage: Required<LlmUsage>
  history: AgentMessage[]
  /** 本轮用户消息，用于 S2 记忆抽取（异步，不阻塞回复） */
  userQuery: string
}

function compact(obj: unknown): string {
  try {
    const s = JSON.stringify(obj)
    return s.length <= RESULT_MAX ? s : s.slice(0, RESULT_MAX) + '…'
  } catch {
    return '{"error":"SERIALIZE"}'
  }
}

export function parseArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// S0 阶段没有工具；S2 接入人格/记忆时在这里注册并返回数据
export function executeTool(_name: string, _args: unknown, _ctx?: unknown): ToolOutcome {
  return { ok: false, error: 'NO_TOOLS' }
}

export function publicHistory(messages: AgentMessage[] | undefined): AgentMessage[] {
  return (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }))
}

export function emptyAgentChat(): { messages: AgentMessage[]; updatedAt: number } {
  return { messages: [], updatedAt: 0 }
}

export function trimByUserTurns(messages: AgentMessage[] | undefined, maxTurns = HISTORY_TURNS): AgentMessage[] {
  const list = Array.isArray(messages) ? messages.filter((m) => m && m.role && m.role !== 'system') : []
  const userIdx: number[] = []
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.role === 'user') userIdx.push(i)
  }
  if (userIdx.length <= maxTurns) return list
  return list.slice(userIdx[userIdx.length - maxTurns]!)
}

export async function runAgent({
  history,
  userQuery,
  aiConfig,
  ctx = {},
  logger,
  systemPrompt,
  callLLM,
  onProgress,
}: RunAgentOptions): Promise<RunAgentResult> {
  const q = String(userQuery || '').trim()
  if (!q) throw new Error('EMPTY_QUERY')
  if (!aiConfig || !aiConfig.token) throw new Error('NO_TOKEN')

  const tools = TOOLS
  const labels = TOOL_LABELS

  const messages: AgentMessage[] = [
    { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
    ...trimByUserTurns(history || []),
    { role: 'user', content: q },
  ]

  const usageTotal: Required<LlmUsage> = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const toolsUsed: string[] = []

  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await callLLM({
      baseUrl: aiConfig.baseUrl,
      token: aiConfig.token,
      model: aiConfig.model,
      messages,
      tools,
      jsonMode: false,
      temperature: 0.7,
      maxTokens: 800,
      timeoutMs: 20000,
    })
    if (result.usage) {
      usageTotal.prompt_tokens += result.usage.prompt_tokens || 0
      usageTotal.completion_tokens += result.usage.completion_tokens || 0
      usageTotal.total_tokens += result.usage.total_tokens || 0
    }

    const calls = result.tool_calls || []
    if (calls.length === 0) {
      const text = String(result.content || '').trim()
      if (!text) throw new Error('EMPTY_TEXT')
      messages.push({ role: 'assistant', content: text })
      logger?.info('agent.run', `done steps=${step + 1} tools=${toolsUsed.join(',') || 'none'}`)
      return {
        text,
        toolsUsed,
        usage: usageTotal,
        history: trimByUserTurns(messages.filter((m) => m.role !== 'system')),
        userQuery: q,
      }
    }

    messages.push({ role: 'assistant', content: result.content || '', tool_calls: calls })

    for (const call of calls) {
      const name = call.function?.name || call.name || ''
      const args = parseArgs(call.function?.arguments || call.arguments)
      const id = call.id || `call_${toolsUsed.length}`
      logger?.info('agent.tool', `name=${name}`)
      onProgress?.({ tool: name, label: labels[name] || name })
      toolsUsed.push(name)
      const out = executeTool(name, args, ctx)
      messages.push({ role: 'tool', tool_call_id: id, content: compact(out) })
    }
  }

  throw new Error('AGENT_MAX_STEPS')
}
