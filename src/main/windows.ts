// windows.ts - 五个窗口的创建 / 定位 / 显隐
// 所有窗口共用同一个 preload 白名单；contextIsolation 开启、nodeIntegration 关闭。

import path from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import { AI_INPUT_HEIGHT, AI_INPUT_WIDTH, BALL_HALO, BALL_SIZE, state, windows } from './state'
import { preloadPath, rendererFile } from './scripts'
import { store } from './store'
import { logger } from './services/logger'
import { broadcastPersona } from './tray'
import { sendAiInputFocus } from './chat'
import type { Position } from '../shared/types'

// Electron 30 的 TS 类型未包含该 API（运行时存在）
function excludeFromAltTab(win: BrowserWindow): void {
  const w = win as BrowserWindow & { setExcludedFromAltTab?: (flag: boolean) => void }
  if (typeof w.setExcludedFromAltTab === 'function') w.setExcludedFromAltTab(true)
}

// ---------- 屏幕与位置 ----------
export function getPrimaryBounds(): Electron.Rectangle {
  return screen.getPrimaryDisplay().bounds
}

/** 球在 transform 坐标系下的默认位置（屏幕右下角） */
export function getDefaultPosition(): Position {
  const b = getPrimaryBounds()
  return { x: b.width - BALL_SIZE - 40, y: b.height - BALL_SIZE - 40 }
}

/** 把保存的 transform 位置 clamp 到屏幕内 */
export function clampPosition(pos: Partial<Position> | null | undefined): Position {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return getDefaultPosition()
  const b = getPrimaryBounds()
  return {
    x: Math.max(0, Math.min(pos.x, b.width - BALL_SIZE)),
    y: Math.max(0, Math.min(pos.y, b.height - BALL_SIZE)),
  }
}

/** 球的实时屏幕坐标（整数；Electron setPosition 不接受浮点） */
export function getBallScreenPos(): Position {
  const b = windows.ball && !windows.ball.isDestroyed() ? windows.ball.getBounds() : { x: 0, y: 0 }
  return { x: Math.round(b.x + (state.currentBallPos.x || 0)), y: Math.round(b.y + (state.currentBallPos.y || 0)) }
}

/** 60fps 通道的兜底落盘：400ms 合并一次 */
export function persistBallPosition(x: number, y: number): void {
  state.lastPersistedPos = clampPosition({ x, y })
  if (state.positionSaveTimer) return
  state.positionSaveTimer = setTimeout(() => {
    state.positionSaveTimer = null
    if (state.lastPersistedPos) store.set('position', state.lastPersistedPos)
  }, 400)
}

/** 退出前把待写入位置立即落盘 */
export function flushPosition(): void {
  if (state.positionSaveTimer) {
    clearTimeout(state.positionSaveTimer)
    state.positionSaveTimer = null
  }
  if (state.lastPersistedPos) {
    store.set('position', state.lastPersistedPos)
  } else if (windows.ball && !windows.ball.isDestroyed()) {
    const [x, y] = windows.ball.getPosition()
    store.set('position', clampPosition({ x, y }))
  }
}

// ---------- 团子猫窗口（全屏透明覆盖层） ----------
export function createBallWindow(): BrowserWindow {
  if (windows.ball && !windows.ball.isDestroyed()) return windows.ball
  const bounds = getPrimaryBounds()
  try {
    const win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        preload: preloadPath,
      },
    })
    windows.ball = win

    excludeFromAltTab(win)
    // 默认整窗穿透；forward 让 mousemove 仍进入 renderer，主进程按光标位置收回
    win.setIgnoreMouseEvents(true, { forward: true })

    win.loadFile(rendererFile('pet'))
    win.once('ready-to-show', () => {
      if (!state.startHidden) win.show()
    })
    win.webContents.once('did-finish-load', () => broadcastPersona(store.get('persona') || 'cat'))
    win.on('close', (e) => {
      if (!state.isQuitting) {
        e.preventDefault()
        win.hide()
      }
    })
    win.on('closed', () => {
      windows.ball = null
    })
    return win
  } catch (e) {
    logger.error('main.window', `createBallWindow failed: ${(e as Error).message}`)
    throw e
  }
}

// ---------- 设置面板 ----------
export function createSettingsWindow(): BrowserWindow {
  if (windows.settings && !windows.settings.isDestroyed()) {
    windows.settings.show()
    windows.settings.focus()
    return windows.settings
  }
  try {
    const win = new BrowserWindow({
      width: 460,
      height: 680,
      minWidth: 400,
      minHeight: 480,
      transparent: false,
      frame: true,
      title: '设置',
      alwaysOnTop: false,
      resizable: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: false,
      backgroundColor: '#141019',
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath },
    })
    windows.settings = win
    win.setMenuBarVisibility(false)
    win.loadFile(rendererFile('settings'))
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      windows.settings = null
    })
    return win
  } catch (e) {
    logger.error('main.window', `createSettingsWindow failed: ${(e as Error).message}`)
    throw e
  }
}

// ---------- 对话浮窗 ----------
export function createAiInputWindow(): BrowserWindow {
  if (windows.aiInput && !windows.aiInput.isDestroyed()) return windows.aiInput
  try {
    const win = new BrowserWindow({
      width: AI_INPUT_WIDTH,
      height: AI_INPUT_HEIGHT,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath },
    })
    windows.aiInput = win
    excludeFromAltTab(win)
    win.setMenuBarVisibility(false)
    win.loadFile(rendererFile('chat'))
    win.on('blur', () => {
      if (windows.aiInput && !windows.aiInput.isDestroyed()) windows.aiInput.hide()
    })
    win.on('closed', () => {
      windows.aiInput = null
    })
    return win
  } catch (e) {
    logger.error('main.window', `createAiInputWindow failed: ${(e as Error).message}`)
    throw e
  }
}

/** 浮窗定位：贴在球的右上角，越界自动换边 */
export function positionAiInputNearBall(): void {
  if (!windows.aiInput || windows.aiInput.isDestroyed()) return
  const pos = getBallScreenPos()
  const work = screen.getPrimaryDisplay().workArea
  const w = AI_INPUT_WIDTH
  const h = AI_INPUT_HEIGHT
  let x = pos.x + BALL_SIZE + 8
  let y = pos.y - 20
  if (x + w > work.x + work.width) x = pos.x - w - 8
  if (x < work.x) x = work.x + 8
  if (y + h > work.y + work.height) y = work.y + work.height - h - 8
  if (y < work.y) y = work.y + 8
  windows.aiInput.setPosition(Math.round(x), Math.round(y))
}

/** 托盘 / 右键 / 快捷键共用同一路径 */
export function openAiInputWindow(): void {
  const win = createAiInputWindow()
  positionAiInputNearBall()
  win.show()
  win.focus()
  sendAiInputFocus(win)
}

// ---------- 猫的笔记本 ----------
export function createNotebookWindow(): BrowserWindow {
  if (windows.notebook && !windows.notebook.isDestroyed()) {
    windows.notebook.show()
    windows.notebook.focus()
    return windows.notebook
  }
  const win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 420,
    minHeight: 480,
    transparent: false,
    frame: true,
    title: '猫的笔记本',
    backgroundColor: '#141019',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath },
  })
  windows.notebook = win
  win.setMenuBarVisibility(false)
  win.loadFile(rendererFile('notebook'))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    windows.notebook = null
  })
  return win
}

// ---------- 协议同意 ----------
export function createConsentWindow(): BrowserWindow {
  if (windows.consent && !windows.consent.isDestroyed()) {
    windows.consent.show()
    windows.consent.focus()
    return windows.consent
  }
  const win = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 460,
    minHeight: 520,
    resizable: true,
    transparent: false,
    frame: true,
    title: '欢迎使用 · 桌面陪伴',
    backgroundColor: '#141019',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath },
  })
  windows.consent = win
  win.setMenuBarVisibility(false)
  win.loadFile(rendererFile('consent'))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    windows.consent = null
  })
  // 未同意就关窗 → 退出应用
  win.on('close', () => {
    if (needsConsent()) {
      state.isQuitting = true
      setTimeout(() => app.quit(), 50)
    }
  })
  return win
}

export const AGREEMENT_VERSION = 2

export function needsConsent(): boolean {
  return Number(store.get('consentVersion') || 0) < AGREEMENT_VERSION
}

// ---------- 法律文档 ----------
export function createLegalWindow(docKey: string): BrowserWindow {
  const key = ['privacy', 'terms', 'disclaimer', 'thirdparty'].includes(docKey) ? docKey : 'privacy'
  if (windows.legal && !windows.legal.isDestroyed()) {
    windows.legal.loadFile(rendererFile('legal'), { search: 'doc=' + key })
    windows.legal.show()
    windows.legal.focus()
    return windows.legal
  }
  const win = new BrowserWindow({
    width: 760,
    height: 740,
    minWidth: 480,
    minHeight: 420,
    transparent: false,
    frame: true,
    title: '法律与隐私',
    backgroundColor: '#141019',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath },
  })
  windows.legal = win
  win.setMenuBarVisibility(false)
  win.loadFile(rendererFile('legal'), { search: 'doc=' + key })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    windows.legal = null
  })
  return win
}

// 仅供类型提示：避免未使用的 import 被移除（path 在 loader 中由 electron 处理）
void path
void BALL_HALO
