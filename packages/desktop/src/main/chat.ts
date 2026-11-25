// chat.ts - AI 对话编排（会话历史、错误文案、进度推送）

import * as agent from '../core/agent'
import { composeSystemPrompt } from '../core/persona'
import * as ai from './services/ai'
import { logger } from './services/logger'
import {
  aiFallbackNotice,
  clearAgentChat,
  getMemories,
  getAgentHistory,
  resolveAiConfig,
  saveAgentChat,
  setAgentHistory,
  store,
  withAiFallback,
} from './store'
import { windows } from './state'
import { createSettingsWindow } from './windows'
import { extractMemories, ensureDailyDiary } from './remember'
import * as occasions from './occasions'
import * as dailyLog from './dailyLog'
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

  // P1.5：用户这句话里如果有「未来的事」，先记住（零 token 正则，不受 AI 成败影响）
  const remembered = occasions.rememberFromMessage(query)
  // M7：如果是「今天花了10块」这类当天的事，也记下
  const dailyLogged = dailyLog.rememberDaily(query)
  if (remembered.length && remembered[0]) {
    const line = `我记住了：${remembered[0].text}`
    if (windows.aiInput && !windows.aiInput.isDestroyed()) {
      windows.aiInput.webContents.send('ai-agent-progress', { tool: 'memory', label: line })
    }
    logger.info('occasion.chat', `remembered ${remembered[0].kind} @ ${remembered[0].date}`)
  } else if (dailyLogged) {
    // 日常记事只回一句「嗯，记下了」——不打断、不追问、不评价
    if (windows.aiInput && !windows.aiInput.isDestroyed()) {
      windows.aiInput.webContents.send('ai-agent-progress', { tool: 'memory', label: '嗯，记下了。' })
    }
  }

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
        // S2：人格卡 + 长期记忆合成为 system prompt
        systemPrompt: composeSystemPrompt(store.get('pet')?.name, getMemories()),
        callLLM: ai.callLLM,
        onProgress: sendProgress,
      }),
    )
    setAgentHistory(result.history || [])
    saveAgentChat()
    logger.info('agent.chat', `tokens=${result.usage.total_tokens || '?'} fallback=${usedFallback}`)
    // 记忆抽取：回复已返回，异步进行；失败静默。
    // 抽完再刷新当天日记——否则启动时写下的「今天你几乎没出现」会一整天不更新。
    void extractMemories(result.history || []).then(() => ensureDailyDiary())
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
