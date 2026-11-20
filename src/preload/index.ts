// preload/index.ts - 安全 IPC 边界
// 仅暴露白名单 API 到渲染端，绝不直接暴露 ipcRenderer。
// 契约：src/shared/types.ts 的 CompanionApi；通道名：src/shared/ipc.ts

import { contextBridge, ipcRenderer } from 'electron'
import { CH, EV } from '../shared/channels'
import type { CompanionApi, Rect } from '../shared/types'

function subscribe<T extends unknown[]>(channel: string, handler: (...args: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => handler(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: CompanionApi = {
  getConfig: (key) => ipcRenderer.invoke(CH.getConfig, key),
  saveConfig: (key, value) => ipcRenderer.invoke(CH.saveConfig, key, value),

  getPersona: () => ipcRenderer.invoke(CH.getPersona),
  setPersona: (name) => ipcRenderer.invoke(CH.setPersona, name),
  setPetName: (name) => ipcRenderer.invoke(CH.setPetName, name),

  // 笔记本 / 记忆 / 备份（S2）
  openNotebook: () => ipcRenderer.invoke(CH.openNotebook),
  getNotebookView: () => ipcRenderer.invoke(CH.getNotebookView),
  exportNotebookMarkdown: () => ipcRenderer.invoke(CH.exportNotebookMarkdown),
  getMemories: () => ipcRenderer.invoke(CH.getMemories),
  deleteMemory: (id) => ipcRenderer.invoke(CH.deleteMemory, id),
  clearMemories: () => ipcRenderer.invoke(CH.clearMemories),
  setMemoryEnabled: (enabled) => ipcRenderer.invoke(CH.setMemoryEnabled, enabled),
  exportBackup: () => ipcRenderer.invoke(CH.exportBackup),
  importBackup: () => ipcRenderer.invoke(CH.importBackup),
  bumpInteraction: () => ipcRenderer.invoke(CH.bumpInteraction),

  // 许愿瓶（S3）
  bottleStatus: () => ipcRenderer.invoke(CH.bottleStatus),
  bottleToggle: (payload) => ipcRenderer.invoke(CH.bottleToggle, payload),
  bottleThrow: (body) => ipcRenderer.invoke(CH.bottleThrow, body),
  bottlePick: (force) => ipcRenderer.invoke(CH.bottlePick, !!force),
  bottleReply: (bottleId, body) => ipcRenderer.invoke(CH.bottleReply, bottleId, body),
  bottleInbox: () => ipcRenderer.invoke(CH.bottleInbox),
  bottleReport: (target, reason) => ipcRenderer.invoke(CH.bottleReport, target, reason),
  openMail: () => ipcRenderer.invoke(CH.openMail),
  bottlePatrolNow: () => ipcRenderer.invoke(CH.bottlePatrolNow),

  savePosition: (x, y) => ipcRenderer.invoke(CH.savePosition, x, y),
  updateBallPos: (x, y) => ipcRenderer.invoke(CH.updateBallPos, x, y),
  getScreenInfo: () => ipcRenderer.invoke(CH.getScreenInfo),
  setHitRegion: (rect: Rect | null) => ipcRenderer.send(CH.setHitRegion, rect),

  openSettings: () => ipcRenderer.invoke(CH.openSettings),
  openLegal: (key) => ipcRenderer.invoke(CH.openLegal, key),
  acceptConsent: () => ipcRenderer.invoke(CH.acceptConsent),
  quitApp: () => ipcRenderer.invoke(CH.quitApp),
  previewBallAnim: () => ipcRenderer.invoke(CH.previewBallAnim),

  getLlmStatus: () => ipcRenderer.invoke(CH.getLlmStatus),
  getOnlineAiConfig: () => ipcRenderer.invoke(CH.getOnlineAiConfig),
  saveOnlineAiConfig: (payload) => ipcRenderer.invoke(CH.saveOnlineAiConfig, payload),
  clearOnlineAiToken: () => ipcRenderer.invoke(CH.clearOnlineAiToken),
  testOnlineAi: () => ipcRenderer.invoke(CH.testOnlineAi),
  getLocalModels: () => ipcRenderer.invoke(CH.getLocalModels),
  setLocalModel: (name) => ipcRenderer.invoke(CH.setLocalModel, name),
  pullLocalModel: (name) => ipcRenderer.invoke(CH.pullLocalModel, name),

  openAiInput: () => ipcRenderer.invoke(CH.openAiInput),
  closeAiInput: () => ipcRenderer.invoke(CH.closeAiInput),
  aiInterpretAsk: (payload) => ipcRenderer.invoke(CH.aiInterpretAsk, payload),
  resetAgentChat: () => ipcRenderer.invoke(CH.resetAgentChat),

  onPersonaChanged: (handler) => subscribe(EV.personaChanged, handler),
  onPreviewBallAnim: (handler) => subscribe(EV.previewBallAnim, handler),
  onAiInputFocus: (handler) => subscribe(EV.aiInputFocus, handler),
  onAiInputLoading: (handler) => subscribe(EV.aiInputLoading, handler),
  onAiInputError: (handler) => subscribe(EV.aiInputError, handler),
  onAgentProgress: (handler) => subscribe(EV.agentProgress, handler),
  onConfigChanged: (handler) => subscribe(EV.configChanged, handler),
  onCursorMoved: (handler) => subscribe(EV.cursorMoved, handler),

  logInfo: (scope, msg, meta) => ipcRenderer.send(CH.logInfo, scope, msg, meta),
  logWarn: (scope, msg, meta) => ipcRenderer.send(CH.logWarn, scope, msg, meta),
  logError: (scope, msg, meta) => ipcRenderer.send(CH.logError, scope, msg, meta),
  logCritical: (scope, msg, meta) => ipcRenderer.send(CH.logCritical, scope, msg, meta),
}

contextBridge.exposeInMainWorld('api', api)
