// remember.ts - 对话后的异步记忆抽取与每日日记（主进程编排）
// 原则：
// - 抽取在回复之后异步进行，任何失败都静默（不能影响对话体验、不能弹错）
// - 只在 20 字以上或 3 轮以上才花 token（shouldExtract）
// - 用户可以在设置里关掉（memoryEnabled）

import * as memory from '../core/memory'
import * as notebook from '../core/notebook'
import { dateKey } from '../core/petState'
import type { AgentMessage, PetSettings } from '../shared/types'
import * as ai from './services/ai'
import { logger } from './services/logger'
import { getMemories, getNotebook, isMemoryEnabled, resolveAiConfig, setMemories, setNotebook, store } from './store'

// 同一时间只跑一次抽取，避免连发多个请求
let extracting = false

export interface ExtractOutcome {
  added: number
  total: number
  skipped: string
}

/** 异步抽取记忆。永不抛出。 */
export async function extractMemories(history: AgentMessage[]): Promise<ExtractOutcome> {
  const none = { added: 0, total: getMemories().length, skipped: '' }
  if (!isMemoryEnabled()) return { ...none, skipped: 'disabled' }
  if (extracting) return { ...none, skipped: 'busy' }
  if (!memory.shouldExtract(history)) return { ...none, skipped: 'short' }

  extracting = true
  try {
    const cfg = await resolveAiConfig()
    if (!cfg.token) return { ...none, skipped: 'no-token' }

    const res = await ai.callLLM({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      model: cfg.model,
      messages: memory.buildExtractMessages({ messages: history }),
      temperature: 0.2,
      maxTokens: 300,
      timeoutMs: 15000,
      // 本地小模型对 json_object 不稳，退回纯文本逐行解析
      jsonMode: cfg.source !== 'local',
    })

    const facts = memory.parseExtractedFacts(res.content)
    if (!facts.length) {
      logger.info('memory.extract', 'no facts')
      return { ...none, skipped: 'empty' }
    }

    const before = getMemories()
    const merged = memory.mergeMemories(before, facts)
    setMemories(merged)
    const added = merged.length - before.length
    logger.info('memory.extract', `facts=${facts.length} added=${added} total=${merged.length}`)
    return { added, total: merged.length, skipped: '' }
  } catch (e) {
    // 记忆是增强功能，失败只记 warn，不影响任何用户可见流程
    logger.warn('memory.extract', `failed: ${(e as Error).message}`)
    return { ...none, skipped: 'error' }
  } finally {
    extracting = false
  }
}

function emptyPet(): PetSettings {
  return { name: '', lastInteractAt: 0, lastGreetDate: '' }
}

/** 已记录的今日交互次数 */
function interactionsToday(now: number): number {
  const pet = store.get('pet') || emptyPet()
  return pet.lastInteractDay === dateKey(now) ? pet.interactionsToday || 0 : 0
}

/**
 * 刷新今天的日记。日记每天只有一条，但素材会随时间变化：
 * 启动时没有对话 → 写了「今天你几乎没出现」；之后聊过天就必须重算，
 * 否则当天的日记会一直是早上的版本。
 */
export function ensureDailyDiary(now = Date.now()): void {
  try {
    const pet = store.get('pet') || emptyPet()
    const today = new Date(now).toDateString()

    const history = store.get('agentChat')?.messages || []
    const userTurns = history.filter((m) => m.role === 'user').length
    const lines = notebook.buildDiaryLines({
      now,
      userTurns,
      interactions: interactionsToday(now),
      memories: getMemories(),
      talkedToday: userTurns > 0,
    })

    // 内容没变就不重写（避免每分钟都落盘）
    const existing = getNotebook().entries.find((e) => e.date === dateKey(now))
    const unchanged =
      !!existing && existing.lines.length === lines.length && existing.lines.every((l, i) => l === lines[i])
    if (unchanged && pet.lastDiaryDate === today) return

    const next = notebook.upsertDiary(getNotebook(), now, lines)
    setNotebook(next)
    store.set('pet', { ...pet, lastDiaryDate: today })
    logger.info('notebook.diary', `wrote ${lines.length} lines (${dateKey(now)})`)
  } catch (e) {
    logger.warn('notebook.diary', `failed: ${(e as Error).message}`)
  }
}

/** 交互计数：由团子猫窗口的状态变化驱动，跨天自动归零 */
export function bumpInteraction(now = Date.now()): void {
  const pet = store.get('pet') || emptyPet()
  const day = dateKey(now)
  const sameDay = pet.lastInteractDay === day
  store.set('pet', {
    ...pet,
    lastInteractDay: day,
    interactionsToday: sameDay ? (pet.interactionsToday || 0) + 1 : 1,
  })
}

/** 供聊天链路使用：当前人格名 */
export function currentPetName(): string {
  return store.get('pet')?.name || ''
}
