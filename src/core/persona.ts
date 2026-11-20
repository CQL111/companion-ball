// persona.ts - 人格卡（领域层，零平台依赖）
// 把 src/data/persona.json 与用户的起名（store.pet.name）合成为 system prompt。
// 人格是角色「是什么人」的唯一来源，台词库管「怎么说话」，这里管「是谁」。

import personaCard from '../data/persona.json'

export interface PersonaCard {
  version: number
  species: string
  voice: string
  habits: string[]
  quirks: string[]
  boundaries: string[]
  tone_rules: string[]
}

export const DEFAULT_PERSONA = personaCard as PersonaCard

export interface BuildSystemPromptInput {
  /** 用户在设置里起的名字；空表示还没起 */
  name?: string
  persona?: PersonaCard
}

/**
 * 生成 system prompt。调用方负责拼接记忆块与历史，本函数只产出「人格段」。
 * 规则（docs/ROADMAP.md）：
 * - 人格卡是角色边界的唯一来源，不在这里临时加戏
 * - 名字是可选注入：没有名字时用「小团子猫」自称
 */
export function buildSystemPrompt({ name, persona = DEFAULT_PERSONA }: BuildSystemPromptInput = {}): string {
  const who = name?.trim() ? `你叫${name.trim()}，` : ''
  const lines: string[] = [
    `你是常驻用户桌面的${persona.species}，${who}一个陪伴型角色，不是助手。`,
    `说话风格：${persona.voice}`,
  ]

  if (persona.habits.length) lines.push(`你的习性：${persona.habits.join('；')}。`)
  if (persona.quirks.length) lines.push(`你的小习惯：${persona.quirks.join('；')}。`)
  if (persona.boundaries.length) lines.push(`你的边界：${persona.boundaries.join('；')}。`)
  if (persona.tone_rules.length) lines.push(`说话规则：${persona.tone_rules.join('；')}。`)

  return lines.join('\n')
}

/**
 * 记忆块：单独注入，和人格分开，方便测试与按条删除。
 * 空记忆返回空串，调用方应跳过拼接（不要塞一个空标题进 prompt）。
 */
export function buildMemoryBlock(memories: Array<{ text: string }>): string {
  const items = memories.map((m) => m.text.trim()).filter(Boolean)
  if (!items.length) return ''
  return [
    '以下是关于用户的事实。只在相关时自然提起，不要罗列；被问到时请据此回答，不要说不知道或记不清：',
    ...items.map((t) => `- ${t}`),
  ].join('\n')
}

/** 把人格段与记忆块拼成最终的 system prompt */
export function composeSystemPrompt(name: string | undefined, memories: Array<{ text: string }>): string {
  const persona = buildSystemPrompt({ name })
  const memory = buildMemoryBlock(memories)
  return memory ? `${persona}\n\n${memory}` : persona
}
