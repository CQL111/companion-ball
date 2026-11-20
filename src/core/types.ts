// 领域类型：core 自己拥有，shared 再向上扩展。
// 规则：这里不出现任何平台 API（不引用 Electron / DOM / Node）。

export type Persona = 'cat'

export type AgentRole = 'user' | 'assistant' | 'system' | 'tool'

export interface AgentMessage {
  role: AgentRole
  content: string
  tool_calls?: unknown[]
  tool_call_id?: string
}

export interface AgentChat {
  messages: AgentMessage[]
  updatedAt: number
}

export interface AiConfig {
  baseUrl: string
  token: string
  model: string
}

export type AiSource = 'user' | 'env' | 'bundled' | 'none'

export interface Position {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ScreenInfo {
  width: number
  height: number
  x: number
  y: number
}

import type { Memory } from './memory'
import type { Notebook } from './notebook'

export interface PetSettings {
  /** 起名；空表示用户还没起名 */
  name: string
  /** 与猫最后一次交互的时间戳（状态机持久化） */
  lastInteractAt: number
  /** 上次说早安的本地日期（YYYY-MM-DD） */
  lastGreetDate: string
  /** 上次写日记的本地日期（toDateString 格式）；S2 */
  lastDiaryDate?: string
  /** 当日交互次数（用于日记素材）；S2 */
  lastInteractDay?: string
  interactionsToday?: number
}

export interface StoreShape {
  position: Position | null
  autoStart: boolean
  aiConfig: AiConfig
  localModel: string
  installId: string
  persona: Persona
  agentChat: AgentChat
  consentVersion: number
  animations: boolean
  /** 轻合成音效开关（v0.5.0） */
  sound: boolean
  pet: PetSettings
  /** 长期记忆（S2）；只在本地，上限见 core/memory.ts */
  memories: Memory[]
  /** 猫的笔记本（S2） */
  notebook: Notebook
  /** 记忆抽取开关（默认开） */
  memoryEnabled: boolean
}

export type ConfigKey = keyof StoreShape
