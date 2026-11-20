// IPC 通道名常量（零依赖，preload / main / 渲染端都引用这里）
// 拼错通道名会在编译期暴露；入参校验在 shared/ipc.ts（zod，仅主进程使用）。

export const CH = {
  getConfig: 'get-config',
  saveConfig: 'save-config',
  getPersona: 'get-persona',
  setPersona: 'set-persona',
  setPetName: 'set-pet-name',
  savePosition: 'save-position',
  updateBallPos: 'update-ball-pos',
  getScreenInfo: 'get-screen-info',
  setHitRegion: 'set-hit-region',
  setIgnoreMouse: 'set-ignore-mouse',
  openSettings: 'open-settings',
  openLegal: 'open-legal',
  acceptConsent: 'accept-consent',
  quitApp: 'quit-app',
  previewBallAnim: 'preview-ball-anim',
  getLlmStatus: 'get-llm-status',
  getOnlineAiConfig: 'get-online-ai-config',
  saveOnlineAiConfig: 'save-online-ai-config',
  clearOnlineAiToken: 'clear-online-ai-token',
  testOnlineAi: 'test-online-ai',
  getLocalModels: 'get-local-models',
  setLocalModel: 'set-local-model',
  pullLocalModel: 'pull-local-model',
  openAiInput: 'open-ai-input',
  closeAiInput: 'close-ai-input',
  aiInterpretAsk: 'ai-interpret-ask',
  resetAgentChat: 'reset-agent-chat',
  logInfo: 'log-info',
  logWarn: 'log-warn',
  logError: 'log-error',
  logCritical: 'log-critical',
} as const

export const EV = {
  personaChanged: 'persona-changed',
  previewBallAnim: 'preview-ball-anim',
  aiInputFocus: 'ai-input-focus',
  aiInputLoading: 'ai-input-loading',
  aiInputError: 'ai-input-error',
  agentProgress: 'ai-agent-progress',
  configChanged: 'config-changed',
} as const

export type Channel = (typeof CH)[keyof typeof CH]
export type EventName = (typeof EV)[keyof typeof EV]
