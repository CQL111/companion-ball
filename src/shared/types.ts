// 跨进程共享类型：领域类型从 core 重新导出，这里只增加平台契约（IPC / 视图模型 / window 注入）。

export type { Memory } from '../core/memory'
export type { Notebook, DiaryEntry } from '../core/notebook'
export type { BackupFile } from '../core/backup'

export type {
  AgentChat,
  AgentMessage,
  AgentRole,
  AiConfig,
  AiSource,
  ConfigKey,

  Persona,
  PetSettings,
  Position,
  Rect,
  ScreenInfo,
  StoreShape,
} from '../core/types'

import type { AgentMessage, AiSource, ConfigKey, Persona, Position, Rect, ScreenInfo, StoreShape } from '../core/types'

export interface ResolvedAiConfig {
  baseUrl: string
  token: string
  model: string
  source: 'local' | 'online' | 'bundled' | 'env' | AiSource
  tokenSource?: AiSource
}

// ---------- 视图模型 ----------
export interface LlmStatus {
  source: string
  model: string
  baseUrl: string
  hasToken: boolean
}

export interface OnlineAiConfigView {
  baseUrl: string
  model: string
  hasToken: boolean
  tokenHint: string
  fromEnv: boolean
  fromBundled: boolean
  tokenSource: string
}

export interface LocalModel {
  name: string
  size: number
  sizeLabel: string
}

export interface LocalModelsResult {
  available: boolean
  models: LocalModel[]
}

export interface PullResult {
  ok: boolean
  error?: string | null
}

export interface TestConnectionResult {
  ok: boolean
  model?: string
  error?: string
}

export interface SaveAiConfigResult {
  ok: boolean
  tokenHint: string
  tokenSource: AiSource
}

export interface ChatReply {
  ok: boolean
  text?: string
  notice?: string
  error?: string
}

export interface AiInputFocusPayload {
  messages: AgentMessage[]
}

export interface AiInputErrorPayload {
  kind: string
  text: string
}

export interface AgentProgressPayload {
  tool?: string
  label?: string
}

export interface NotebookView {
  entries: Array<{ date: string; lines: string[] }>
}

export interface MemoryView {
  id: string
  createdAt: string
  text: string
}

export interface MemoryListResult {
  enabled: boolean
  max: number
  memories: MemoryView[]
}

export interface ExportResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

export interface ImportResult {
  ok: boolean
  canceled?: boolean
  error?: string
  stats?: { memories: number; diaryEntries: number }
}

export interface BottleStatusView {
  enabled: boolean
  endpoint: string
  canThrow: boolean
  thrownToday: number
  dailyLimit: number
}

export interface WeatherStatusView {
  /** 是否已开启且配置了城市 */
  enabled: boolean
  place: { city: string; label: string; latitude: number; longitude: number } | null
  /** 当前天气（未开启时为 null） */
  current: { kind: string; isDay: boolean } | null
}

export interface WeatherLookupResult {
  ok: boolean
  place?: { city: string; label: string; latitude: number; longitude: number }
  error?: string
}

export interface MailApiResult<T> {
  ok: boolean
  data?: T
  error?: string
  errorText?: string
}

export interface ResetChatResult {
  ok: boolean
  messages: AgentMessage[]
}

// ---------- 渲染端可见 API（preload 必须与之一致） ----------
export interface CompanionApi {
  getConfig<K extends ConfigKey>(key: K): Promise<StoreShape[K]>
  saveConfig<K extends ConfigKey>(key: K, value: StoreShape[K]): Promise<boolean>

  getPersona(): Promise<Persona>
  setPersona(name: Persona): Promise<Persona>
  setPetName(name: string): Promise<string>

  // 笔记本 / 记忆 / 备份（S2）
  openNotebook(): Promise<boolean>
  getNotebookView(): Promise<NotebookView>
  exportNotebookMarkdown(): Promise<ExportResult>
  getMemories(): Promise<MemoryListResult>
  deleteMemory(id: string): Promise<MemoryListResult>
  clearMemories(): Promise<MemoryListResult>
  setMemoryEnabled(enabled: boolean): Promise<boolean>
  exportBackup(): Promise<ExportResult>
  importBackup(): Promise<ImportResult>
  bumpInteraction(): Promise<boolean>

  // 许愿瓶（S3，需用户主动开启）
  bottleStatus(): Promise<BottleStatusView>
  bottleToggle(payload: { enabled: boolean; endpoint?: string }): Promise<BottleStatusView>
  bottleThrow(body: string): Promise<MailApiResult<{ id: string; alias: string }>>
  bottlePick(force?: boolean): Promise<MailApiResult<{ id: string; body: string; alias: string } | null>>
  bottleReply(bottleId: string, body: string): Promise<MailApiResult<true>>
  bottleInbox(): Promise<MailApiResult<Array<{ bottleBody: string; replyBody: string; replyAlias: string; createdAt: number }>>>
  bottleReport(target: { bottleId?: string; replyId?: string }, reason: 'spam' | 'abuse' | 'other'): Promise<MailApiResult<true>>
  openMail(): Promise<boolean>
  bottlePatrolNow(): Promise<MailApiResult<{ alias: string; body: string } | null>>

  savePosition(x: number, y: number): Promise<Position | null>
  updateBallPos(x: number, y: number): Promise<boolean>
  getScreenInfo(): Promise<ScreenInfo>
  setHitRegion(rect: Rect | null): void

  openSettings(): Promise<boolean>
  openLegal(key: string): Promise<boolean>
  acceptConsent(): Promise<boolean>
  quitApp(): Promise<boolean>
  previewBallAnim(): Promise<boolean>

  getLlmStatus(): Promise<LlmStatus>
  getOnlineAiConfig(): Promise<OnlineAiConfigView>
  saveOnlineAiConfig(payload: { baseUrl: string; model: string; token: string }): Promise<SaveAiConfigResult>
  clearOnlineAiToken(): Promise<{ ok: boolean; hasToken: boolean; fromEnv: boolean }>
  testOnlineAi(): Promise<TestConnectionResult>
  getLocalModels(): Promise<LocalModelsResult>
  setLocalModel(name: string): Promise<boolean>
  pullLocalModel(name: string): Promise<PullResult>

  openAiInput(): Promise<boolean>
  closeAiInput(): Promise<boolean>
  aiInterpretAsk(payload: { query: string }): Promise<ChatReply>
  resetAgentChat(): Promise<ResetChatResult>

  onPersonaChanged(handler: (name: Persona) => void): () => void
  onPreviewBallAnim(handler: () => void): () => void
  onAiInputFocus(handler: (data: AiInputFocusPayload) => void): () => void
  onAiInputLoading(handler: (loading: boolean) => void): () => void
  onAiInputError(handler: (err: AiInputErrorPayload) => void): () => void
  onAgentProgress(handler: (info: AgentProgressPayload) => void): () => void
  onConfigChanged(handler: (key: string, value: unknown) => void): () => void
  /** 主进程光标位置（窗口内坐标），用于让角色看向鼠标 */
  onCursorMoved(handler: (pos: { x: number; y: number }) => void): () => void
  /** 用户离开 / 回来 / 久坐提醒（S4） */
  onPresenceAway(handler: (p: { since: number }) => void): () => void
  onPresenceBack(handler: (p: { awayMs: number }) => void): () => void
  onPresenceSit(handler: (p: { minutes: number; count: number }) => void): () => void
  onWeatherChanged(handler: (p: { kind: string; isDay: boolean; text: string }) => void): () => void
  /** 托盘「重置位置」：渲染端把猫移回默认位置 */
  onResetBall(handler: () => void): () => void
  /** 测试用：与托盘「重置位置」走同一条路径 */
  debugResetBall(): Promise<boolean>

  // 天气氛围（S4，默认关闭）
  weatherStatus(): Promise<WeatherStatusView>
  weatherLookup(city: string): Promise<WeatherLookupResult>
  weatherSet(payload: { enabled: boolean; place?: { city: string; label: string; latitude: number; longitude: number } | null }): Promise<WeatherStatusView>

  logInfo(scope: string, msg: string, meta?: Record<string, unknown>): void
  logWarn(scope: string, msg: string, meta?: Record<string, unknown>): void
  logError(scope: string, msg: string, meta?: Record<string, unknown>): void
  logCritical(scope: string, msg: string, meta?: Record<string, unknown>): void
}

export interface RendererLogger {
  info: (scope: string, msg: string, meta?: Record<string, unknown>) => void
  warn: (scope: string, msg: string, meta?: Record<string, unknown>) => void
  error: (scope: string, msg: string, meta?: Record<string, unknown>) => void
  critical: (scope: string, msg: string, meta?: Record<string, unknown>) => void
}

declare global {
  interface Window {
    api: CompanionApi
    logger: RendererLogger
    LEGAL?: Record<string, { title: string; html: string }>
  }
}
