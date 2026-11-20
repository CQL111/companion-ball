// chat.ts - AI 对话编排（会话历史、错误文案、进度推送）

import * as agent from '../core/agent'
import * as ai from './services/ai'
import { logger } from './services/logger'
import {
  aiFallbackNotice,
  clearAgentChat,
  getAgentHistory,
  resolveAiConfig,
  saveAgentChat,
  setAgentHistory,
  store,
  withAiFallback,
} from './store'
import { windows } from './state'
import { createSettingsWindow } from './windows'
import type { AgentMessage, ChatReply } from '../shared/types'

export function sendAiInputFocus(win: Electron.BrowserWindow): void {
  if (!win || win.isDestroyed()) return
  const payload = { messages: agent.publicHistory(getAgentHistory()) }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send('ai-input-focus', payload)
    })
  } else {
    win.webContents.send('ai-input-focus', payload)
  }
}

export function friendlyError(code: string): string {
  return (
    {
      NO_TOKEN: '尚未配置 Token，请先在设置中填入',
      AUTH_FAILED: 'Token 无效或已过期，请检查',
      RATE_LIMITED: '调用太频繁，请稍后再试',
      TIMEOUT: '网络有点慢，稍后再试',
      NETWORK: '网络好像不太给力',
      EMPTY_QUERY: '问题不能为空',
      EMPTY_RESPONSE: '团子没接上话，再说一次试试',
      AGENT_MAX_STEPS: '这轮调用太长，请换个说法再问',
      INSUFFICIENT_BALANCE: 'AI 额度已用尽，请充值或在设置里换用自己的 Key',
      UPSTREAM_ERROR: '模型服务返回错误，稍后再试',
      BAD_JSON: '模型返回格式异常，稍后重试',
      NO_MESSAGES: '请求内容为空',
    } as Record<string, string>
  )[code] || '请求失败：' + code
}

export function resetChat(): { ok: boolean; messages: AgentMessage[] } {
  clearAgentChat()
  logger.info('agent.reset', 'history cleared')
  return { ok: true, messages: [] }
}

export async function handleAsk(rawQuery: string): Promise<ChatReply> {
  const query = String(rawQuery || '').trim()
  if (!query) return { ok: false, error: 'EMPTY_QUERY' }

  const aiCfg = await resolveAiConfig()
  if (!aiCfg.token) {
    if (windows.aiInput && !windows.aiInput.isDestroyed()) {
      windows.aiInput.webContents.send('ai-input-error', { kind: 'NO_TOKEN', text: '请先在设置中配置 API Token' })
      setTimeout(() => createSettingsWindow(), 600)
    }
    return { ok: false, error: 'NO_TOKEN' }
  }

  const ctx = { installId: store.get('installId') }
  const sendProgress = (info: { tool: string; label: string }): void => {
    if (windows.aiInput && !windows.aiInput.isDestroyed()) {
      windows.aiInput.webContents.send('ai-agent-progress', info)
    }
  }

  try {
    const { result, usedFallback } = await withAiFallback((cfg) =>
      agent.runAgent({
        history: getAgentHistory(),
        userQuery: query,
        aiConfig: cfg,
        ctx,
        logger,
        callLLM: ai.callLLM,
        onProgress: sendProgress,
      }),
    )
    setAgentHistory(result.history || [])
    saveAgentChat()
    logger.info('agent.chat', `tokens=${result.usage.total_tokens || '?'} fallback=${usedFallback}`)
    return { ok: true, text: result.text, notice: usedFallback ? aiFallbackNotice : '' }
  } catch (e) {
    const msg = String((e as Error).message || e)
    logger.error('agent.chat', msg, { query: query.slice(0, 50) })
    if (windows.aiInput && !windows.aiInput.isDestroyed()) {
      windows.aiInput.webContents.send('ai-input-error', { kind: msg, text: friendlyError(msg) })
    }
    return { ok: false, error: msg }
  }
}
