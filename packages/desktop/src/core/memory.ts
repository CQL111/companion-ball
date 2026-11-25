// memory.ts - 长期记忆（领域层，零平台依赖）
// 职责：
//  1. 生成「抽取记忆」的提示词（对话结束后异步调用一次便宜模型）
//  2. 稳健解析模型输出（JSON / 纯文本兜底）
//  3. 合并去重、按时间淘汰（上限 30 条）
// 数据只在本地：调用方把结果写进 store，不上传。

import type { AgentMessage } from './types'

export interface Memory {
  id: string
  createdAt: string // UTC ISO
  text: string
}

export const MAX_MEMORIES = 30
/** 单条记忆的长度上限：记忆是「事实摘要」，不是原话摘抄 */
export const MAX_MEMORY_LENGTH = 60
/** 每轮最多新增几条，防止模型一次吐一堆 */
export const MAX_NEW_PER_ROUND = 5

export const EXTRACT_SYSTEM =
  '你是一个记忆抽取器。从对话中提取关于用户的、未来仍然有用的事实。' +
  '只提取用户明确说过的内容，不推测、不评价、不提取角色自己的话。' +
  '每条不超过 30 字，用第三人称陈述，例如「用户住在杭州」「用户最近在准备考试」。' +
  '不要提取一次性的闲聊、情绪宣泄、或敏感隐私（身份证、手机号、住址门牌）。' +
  '只返回 JSON：{"facts":["..."]}，没有可记的就返回 {"facts":[]}。'

export interface ExtractInput {
  messages: AgentMessage[]
}

/** 生成抽取用的消息；只取最近几轮，避免 token 浪费 */
export function buildExtractMessages({ messages }: ExtractInput): AgentMessage[] {
  const recent = messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-8)
  const transcript = recent
    .map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.content}`)
    .join('\n')
    .slice(0, 4000)
  return [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `对话记录：\n${transcript}\n\n请返回 JSON。` },
  ]
}

/** 稳健解析：优先 JSON，其次逐行兜底；过滤空白与超长 */
export function parseExtractedFacts(raw: string): string[] {
  const text = String(raw || '').trim()
  if (!text) return []

  let facts: unknown[] = []
  try {
    const obj = JSON.parse(text)
    if (Array.isArray(obj)) facts = obj
    else if (obj && Array.isArray(obj.facts)) facts = obj.facts
  } catch {
    const m = text.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        const obj = JSON.parse(m[0])
        if (obj && Array.isArray(obj.facts)) facts = obj.facts
      } catch {
        /* 落到逐行兜底 */
      }
    }
    if (!facts.length) {
      facts = text
        .split('\n')
        .map((l) => l.replace(/^[-*\d.、\s]+/, '').trim())
        .filter(Boolean)
    }
  }

  return facts
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.replace(/\s+/g, ' ').trim())
    .filter((f) => f.length > 0 && f.length <= MAX_MEMORY_LENGTH)
    .slice(0, MAX_NEW_PER_ROUND)
}

function normalize(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/** 两条记忆是否重复：完全一致，或一条包含另一条（≥4 字时） */
export function isDuplicate(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return false
  if (na === nb) return true
  return na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))
}

export interface MergeOptions {
  now?: string
  /** id 生成器，便于测试注入 */
  makeId?: () => string
}

/**
 * 合并新记忆：去重 → 新条目追加 → 超过上限时按 createdAt 淘汰最旧的。
 * 不修改入参。
 */
export function mergeMemories(existing: Memory[], incoming: string[], opts: MergeOptions = {}): Memory[] {
  const now = opts.now ?? new Date().toISOString()
  const makeId = opts.makeId ?? (() => `m_${Math.random().toString(36).slice(2, 10)}`)

  const list = existing.slice()
  for (const text of incoming) {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean || clean.length > MAX_MEMORY_LENGTH) continue
    if (list.some((m) => isDuplicate(m.text, clean))) continue
    list.push({ id: makeId(), createdAt: now, text: clean })
  }

  if (list.length <= MAX_MEMORIES) return list
  // 淘汰最旧的：保留最新 MAX_MEMORIES 条，并把返回结果按时间正序排好，
  // 这样注入 prompt 时最近的事实位于末尾（更靠近当前对话，权重更高）
  const sorted = list.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  return sorted.slice(sorted.length - MAX_MEMORIES)
}

/** 删除一条记忆（按 id）。返回新数组，不修改入参。 */
export function removeMemory(memories: Memory[], id: string): Memory[] {
  return memories.filter((m) => m.id !== id)
}

/** 是否值得为这次对话调用抽取（太短的闲聊不花 token） */
export function shouldExtract(messages: AgentMessage[]): boolean {
  const userTurns = messages.filter((m) => m.role === 'user')
  if (!userTurns.length) return false
  const chars = userTurns.reduce((n, m) => n + m.content.length, 0)
  // 20 字以上通常包含可记的事实；更短的闲聊不值得花 token
  return chars >= 20 || userTurns.length >= 3
}

/** 本地兜底标签：不调模型时用于笔记本（不回显用户原话，只做粗分类） */
export function memoryTopics(memories: Memory[]): string[] {
  const topics: string[] = []
  const rules: Array<[RegExp, string]> = [
    [/住在|城市|老家|搬到/, '住处'],
    [/工作|上班|公司|同事|项目/, '工作'],
    [/考试|学习|复习|论文|上课/, '学习'],
    [/睡|失眠|熬夜/, '作息'],
    [/猫|狗|宠物/, '宠物'],
    [/喜欢|爱好|在玩|在追/, '喜好'],
  ]
  for (const [re, label] of rules) {
    if (memories.some((m) => re.test(m.text)) && !topics.includes(label)) topics.push(label)
  }
  return topics
}
