// store.ts - 持久化与 AI 配置解析（主进程唯一读写 store 的地方）
// 规则：只做向后兼容的加法；旧字段读不到时回落，不抛错。

import crypto from 'node:crypto'
import { app } from 'electron'
import Store from 'electron-store'
import type { AgentMessage, AiConfig, Position, StoreShape } from '../shared/types'
import * as agent from '../core/agent'
import * as localLLM from './services/localLLM'
import * as onlineConfig from './services/onlineConfig'
import { logger } from './services/logger'
import type { Memory } from '../core/memory'
import type { Notebook } from '../core/notebook'

export const store = new Store<StoreShape>({
  name: 'config',
  defaults: {
    position: null,
    autoStart: false,
    aiConfig: { baseUrl: '', token: '', model: '' },
    localModel: '',
    installId: '',
    persona: 'cat',
    agentChat: { messages: [], updatedAt: 0 },
    consentVersion: 0,
    animations: true,
    pet: { name: '', lastInteractAt: 0, lastGreetDate: '' },
    memories: [],
    notebook: { version: 1, entries: [] },
    memoryEnabled: true,
  },
})

// ---------- 旧版 Key 迁移 ----------
// 旧版把 API Key 写在 aiConfig.encryptedToken（实际是 base64，非真加密）。
function migrateLegacyAiConfig(): void {
  const cfg = store.get('aiConfig') as AiConfig & { encryptedToken?: string; tokenObfuscated?: string }
  if (!cfg || typeof cfg !== 'object') return
  const hasToken = typeof cfg.token === 'string' && !!cfg.token.trim()
  const legacy = cfg.encryptedToken
  if (!hasToken && typeof legacy === 'string' && legacy) {
    try {
      const token = Buffer.from(legacy, 'base64').toString('utf8').trim()
      if (/^sk-[A-Za-z0-9_-]+$/.test(token)) {
        store.set('aiConfig', { ...cfg, token, encryptedToken: undefined, tokenObfuscated: undefined })
        logger.info('aiConfig', 'migrated legacy encryptedToken → token')
      } else {
        logger.warn('aiConfig', 'legacy encryptedToken present but format unrecognized, skipped')
      }
    } catch (e) {
      logger.warn('aiConfig', `legacy token migration failed: ${(e as Error).message}`)
    }
  } else if (cfg.encryptedToken !== undefined || cfg.tokenObfuscated !== undefined) {
    store.set('aiConfig', { ...cfg, encryptedToken: undefined, tokenObfuscated: undefined })
  }
}
migrateLegacyAiConfig()

function ensureInstallId(): string {
  const cur = store.get('installId')
  if (typeof cur === 'string' && cur.length >= 8) return cur
  const id = crypto.randomUUID()
  store.set('installId', id)
  logger.info('installId', 'generated')
  return id
}
ensureInstallId()

// ---------- 会话历史 ----------
let agentHistory: AgentMessage[] = []

export function loadAgentChat(): void {
  const c = store.get('agentChat') || agent.emptyAgentChat()
  agentHistory = agent.trimByUserTurns(c.messages || [])
}
export function getAgentHistory(): AgentMessage[] {
  return agentHistory
}
export function setAgentHistory(next: AgentMessage[]): void {
  agentHistory = next
}
export function saveAgentChat(): void {
  store.set('agentChat', { messages: agent.trimByUserTurns(agentHistory), updatedAt: Date.now() })
}
export function clearAgentChat(): void {
  agentHistory = []
  store.set('agentChat', agent.emptyAgentChat())
}
loadAgentChat()

// ---------- AI 配置解析 ----------
export interface ActiveAiConfig {
  baseUrl: string
  token: string
  model: string
  source: 'local' | 'online' | 'bundled' | 'env'
}

// 统一入口：有可用 Ollama 则本地；否则设置面板里的线上配置 / `.env`
export async function resolveAiConfig(): Promise<ActiveAiConfig> {
  const localModel = store.get('localModel') || ''
  if (localModel) {
    const ok = await localLLM.checkLocal()
    if (ok) {
      return { baseUrl: localLLM.LOCAL_BASE_URL, token: localLLM.LOCAL_TOKEN, model: localModel, source: 'local' }
    }
    logger.warn('resolveAiConfig', `local model "${localModel}" configured but Ollama unavailable, fallback to online`)
  }
  const r = onlineConfig.resolve(store.get('aiConfig'), { preferEnv: !app.isPackaged })
  return { baseUrl: r.baseUrl, token: r.token, model: r.model, source: 'online' }
}

export function resolveOnline(saved: AiConfig | null | undefined): onlineConfig.ResolvedOnline {
  return onlineConfig.resolve(saved, { preferEnv: !app.isPackaged })
}

export function builtinAiConfig(): ActiveAiConfig | null {
  const bundled = onlineConfig.loadBundled()
  if (bundled && bundled.token) {
    return { baseUrl: bundled.baseUrl, token: bundled.token, model: bundled.model, source: 'bundled' }
  }
  const envCfg = onlineConfig.resolve(null, { preferEnv: true })
  if (envCfg.token) return { baseUrl: envCfg.baseUrl, token: envCfg.token, model: envCfg.model, source: 'env' }
  return null
}

function isUserKeyActive(): boolean {
  const saved = store.get('aiConfig') || ({} as AiConfig)
  const merged = onlineConfig.resolve(saved, { preferEnv: !app.isPackaged })
  return merged.tokenSource === 'user' && !!String(saved.token || '').trim()
}

// 发布版可能内置了 Key；用户自己的 Key 失效时自动回退，并明确告知
export let aiFallbackNotice = ''

export async function withAiFallback<T>(invoke: (cfg: ActiveAiConfig) => Promise<T>): Promise<{
  cfg: ActiveAiConfig
  result: T
  usedFallback: boolean
}> {
  const cfg = await resolveAiConfig()
  aiFallbackNotice = ''
  try {
    return { cfg, result: await invoke(cfg), usedFallback: false }
  } catch (e) {
    const msg = String((e as Error)?.message || e)
    const authFailed = /AUTH_FAILED|HTTP_40[13]/.test(msg)
    if (!authFailed || cfg.source !== 'online' || !isUserKeyActive()) throw e
    const builtin = builtinAiConfig()
    if (!builtin) throw e
    logger.warn('ai.fallback', 'user key auth failed, retry with builtin key')
    aiFallbackNotice = '你的 API Key 已失效，本次已临时使用应用内置 Key；请到设置更新。'
    const result = await invoke({ ...builtin, source: 'online' })
    return { cfg: builtin, result, usedFallback: true }
  }
}

export function defaultPosition(size = 80): Position {
  // 由调用方传入屏幕 bounds；这里只给兜底
  return { x: 0, y: 0 }
}

// ---------- 长期记忆（S2）----------
export function getMemories(): Memory[] {
  const list = store.get('memories')
  return Array.isArray(list) ? list : []
}

export function setMemories(next: Memory[]): void {
  store.set('memories', next)
}

export function isMemoryEnabled(): boolean {
  return store.get('memoryEnabled') !== false
}

// ---------- 笔记本（S2）----------
export function getNotebook(): Notebook {
  const nb = store.get('notebook')
  return nb && Array.isArray(nb.entries) ? nb : { version: 1, entries: [] }
}

export function setNotebook(next: Notebook): void {
  store.set('notebook', next)
}

// ---------- 起名 ----------
export function getPetName(): string {
  return store.get('pet')?.name || ''
}
