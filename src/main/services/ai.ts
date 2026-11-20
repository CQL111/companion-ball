// ai.ts - LLM 调用封装（主进程侧）
// 用 Electron 内置 net.fetch，无需第三方依赖
// 线上：DeepSeek OpenAI 兼容 API；备用：本地 Ollama
// 所有调用失败都 throw，由调用方决定降级（浮窗显示错误提示）

import { net } from 'electron'
import { logger } from './logger'
import type { AgentMessage } from '../../shared/types'
import type { ToolCall } from '../../core/agent'

export const DEFAULT_MODEL = 'deepseek-chat'

export function detectEndpoint(baseUrl: string): { kind: 'openai'; url: string; isLocal: boolean } {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '')
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(u)
  u = u.replace(/\/v\d+$/, '')
  return { kind: 'openai', url: u + '/v1/chat/completions', isLocal }
}

export function normalizeBaseUrl(baseUrl: string): string {
  let url = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!url) return 'https://api.deepseek.com/v1'
  if (!/\/v\d+$/.test(url)) url += '/v1'
  return url
}

// ---------- 失败去重：同类错误 5 分钟内只记一次 error，其余降为 warn ----------
const FAIL_DEDUPE_MS = 5 * 60 * 1000
const lastFailAt = new Map<string, number>()
function shouldLogAsError(key: string): boolean {
  const now = Date.now()
  const last = lastFailAt.get(key) || 0
  if (now - last < FAIL_DEDUPE_MS) return false
  lastFailAt.set(key, now)
  return true
}

export interface CallLlmParams {
  baseUrl: string
  token: string
  messages: AgentMessage[]
  model?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  tools?: unknown[]
  jsonMode?: boolean
}

export interface CallLlmResponse {
  content: string
  tool_calls: ToolCall[]
  finish_reason: string
  usage: Record<string, number>
  model: string
}

export async function callLLM({
  baseUrl,
  token,
  messages,
  model = DEFAULT_MODEL,
  temperature = 0.7,
  maxTokens = 600,
  timeoutMs = 12000,
  tools,
  jsonMode,
}: CallLlmParams): Promise<CallLlmResponse> {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('NO_MESSAGES')

  const ep = detectEndpoint(baseUrl)
  if (!token && !ep.isLocal) throw new Error('NO_TOKEN')
  const startTs = Date.now()
  const hasTools = Array.isArray(tools) && tools.length > 0
  logger.info('ai.callLLM', `model=${model} local=${ep.isLocal} tools=${hasTools} timeout=${timeoutMs}`)

  const body: Record<string, unknown> = { model, messages, temperature, max_tokens: maxTokens }
  if (hasTools) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  // tool 调用不能强制 json_object；本地模型对 json_object 也不稳
  const wantJson = jsonMode !== undefined ? jsonMode : !hasTools && !ep.isLocal
  if (wantJson) body.response_format = { type: 'json_object' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const fail = (code: string, status: number, detail?: string, extra?: Record<string, unknown>): Error => {
    const meta = { code, status: status || 0, model, local: ep.isLocal, timeoutMs, ms: Date.now() - startTs, ...(extra || {}) }
    const line = `${code} status=${status || '-'} ${detail || ''}`.trim()
    if (shouldLogAsError(code)) logger.error('ai.callLLM', line, meta)
    else logger.warn('ai.callLLM', '（重复）' + line, meta)
    return new Error(detail && code.startsWith('HTTP_') ? `${code}: ${detail}` : code)
  }

  let resp: Response
  try {
    resp = await net.fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const err = e as Error
    if (err.name === 'AbortError') throw fail('TIMEOUT', 0, `超过 ${timeoutMs}ms 未返回`)
    throw fail('NETWORK', 0, String(err.message || err))
  }
  clearTimeout(timer)

  const status = resp.status
  let json: any
  try {
    json = await resp.json()
  } catch {
    throw fail('BAD_JSON', status, '响应不是合法 JSON')
  }

  const upstreamMsg = String(
    (json && (json.error?.message || json.error_message || json.message)) || ''
  ).replace(/\s+/g, ' ').slice(0, 200)
  const code = (json && json.error && json.error.code) || ''

  if (status === 401 || status === 403) throw fail('AUTH_FAILED', status, upstreamMsg, { upstreamCode: code })
  if (status === 429) throw fail('RATE_LIMITED', status, upstreamMsg, { upstreamCode: code })
  if (status === 402) throw fail('INSUFFICIENT_BALANCE', status, upstreamMsg, { upstreamCode: code })
  if (status >= 500) throw fail(`SERVER_${status}`, status, upstreamMsg, { upstreamCode: code })
  if (json && json.error && !json.choices) throw fail('UPSTREAM_ERROR', status, upstreamMsg, { upstreamCode: code })
  if (!resp.ok) throw fail(`HTTP_${status}`, status, upstreamMsg, { upstreamCode: code })

  const message = json?.choices?.[0]?.message || {}
  const content = message.content || ''
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const normalizedUsage = json?.usage || {}
  if (!content && toolCalls.length === 0) {
    throw fail('EMPTY_RESPONSE', status, `finish=${json?.choices?.[0]?.finish_reason || '-'}`)
  }

  logger.info('ai.callLLM', `done ${Date.now() - startTs}ms tokens=${normalizedUsage.total_tokens || '?'} tools=${toolCalls.length}`)
  return {
    content,
    tool_calls: toolCalls as ToolCall[],
    finish_reason: json?.choices?.[0]?.finish_reason || '',
    usage: normalizedUsage,
    model: json.model || model,
  }
}

export async function testConnection({
  baseUrl,
  token,
  model,
}: {
  baseUrl: string
  token: string
  model?: string
}): Promise<{ ok: boolean; model?: string; error?: string }> {
  logger.info('ai.testConnection', `baseUrl=${baseUrl} model=${model || DEFAULT_MODEL}`)
  if (!token) return { ok: false, error: 'NO_TOKEN' }
  try {
    const result = await callLLM({
      baseUrl,
      token,
      messages: [
        { role: 'system', content: '你是一个连通性测试助手，只回复 OK。' },
        { role: 'user', content: '回复 OK' },
      ],
      model: model || DEFAULT_MODEL,
      temperature: 0.1,
      maxTokens: 8,
      timeoutMs: 8000,
      jsonMode: false,
    })
    return { ok: true, model: result.model }
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) }
  }
}

const DIAGNOSE_SYSTEM =
  '你是一位资深 Electron 桌面应用工程师，专门负责快速定位错误并给出可执行的修复建议。' +
  '用户会贴最近 50 行日志 + 一条关键错误 + 触发上下文，请你：' +
  '1) 给出最可能的根因（1-2 句中文）' +
  '2) 给出具体修复步骤（1-3 步，不要超过 100 字）' +
  '3) 给信心分（0-1 之间的小数）' +
  '请严格按 JSON 返回：{"rootCause":"...","fix":"...","confidence":0.X}'

export interface Diagnosis {
  rootCause: string
  fix: string
  confidence: number
  model?: string
  usage?: Record<string, number>
}

export async function diagnose({
  line,
  recentLines = [],
  meta = {},
  aiConfig,
  ctx = {},
}: {
  line: string
  recentLines?: string[]
  meta?: Record<string, unknown>
  aiConfig: { baseUrl: string; token: string; model?: string }
  ctx?: Record<string, unknown>
}): Promise<Diagnosis> {
  logger.info('ai.diagnose', `line=${(line || '').slice(0, 80)}`)
  if (!aiConfig || !aiConfig.token) throw new Error('NO_TOKEN')

  const tailLines = (recentLines || []).slice(-50).join('\n').slice(0, 4000)
  const userPrompt =
    `【错误】\n${line}\n\n` +
    `【最近 50 行日志】\n${tailLines || '(空)'}\n\n` +
    `【触发上下文】\n${JSON.stringify({ ...ctx, meta }, null, 0).slice(0, 800)}\n\n` +
    '请返回 JSON：{"rootCause":"...","fix":"...","confidence":0.X}'

  const messages: AgentMessage[] = [
    { role: 'system', content: DIAGNOSE_SYSTEM },
    { role: 'user', content: userPrompt },
  ]

  const result = await callLLM({
    baseUrl: aiConfig.baseUrl,
    token: aiConfig.token,
    messages,
    model: aiConfig.model || DEFAULT_MODEL,
    temperature: 0.3,
    maxTokens: 400,
    timeoutMs: 15000,
  })

  let parsed: any
  try {
    parsed = JSON.parse(String(result.content || '').trim())
  } catch {
    const m = String(result.content || '').match(/\{[\s\S]*\}/)
    if (m) {
      try {
        parsed = JSON.parse(m[0])
      } catch {
        /* ignore */
      }
    }
  }
  if (!parsed || typeof parsed.rootCause !== 'string') throw new Error('EMPTY_TEXT')

  return {
    rootCause: String(parsed.rootCause || '').slice(0, 200),
    fix: String(parsed.fix || '').slice(0, 300),
    confidence:
      typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    model: result.model,
    usage: result.usage,
  }
}
