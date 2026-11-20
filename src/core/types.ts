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

export interface PetSettings {
  /** 起名；空表示用户还没起名 */
  name: string
  /** 与猫最后一次交互的时间戳（状态机持久化） */
  lastInteractAt: number
  /** 上次说早安的本地日期（YYYY-MM-DD） */
  lastGreetDate: string
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
  pet: PetSettings
}

export type ConfigKey = keyof StoreShape
