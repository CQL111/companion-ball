// index.ts - 主进程入口
// 桌面陪伴 · 团子猫（S0：角色壳 + AI 对话骨架）
// 分层与数据流见 docs/ARCHITECTURE.md；领域逻辑在 src/core/（零平台依赖）

import { app, BrowserWindow, globalShortcut } from 'electron'
import * as onlineConfig from './services/onlineConfig'
import { logger } from './services/logger'
import { runSelfCheck } from './services/selfCheck'
import * as localLLM from './services/localLLM'
import { state, windows } from './state'
import { store, resolveOnline } from './store'
import { createBallWindow, createConsentWindow, flushPosition, needsConsent } from './windows'
import { applyAutoStart, createTray } from './tray'
import { getLogWatcher, startWatcher } from './diagnostics'
import { registerIpc, registerLogIpc } from './ipc'
import { startCursorPolling, stopCursorPolling } from './cursor'
import { registerShortcut } from './shortcut'

// Windows 通知必须先设 appId（在 ready 之前）
app.setAppUserModelId('com.companion.ball')

// 单实例锁：第二次启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  logger.info('main.lifecycle', 'second-instance launched')
  const win = windows.ball && !windows.ball.isDestroyed() ? windows.ball : createBallWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.whenReady().then(() => {
  logger.info('main', 'app ready', {
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    packaged: app.isPackaged,
  })
  // 启动诊断：确认 AI 配置来源（user / env / bundled / none），不记录 Key 本身
  try {
    const cfgNow = resolveOnline(store.get('aiConfig'))
    logger.info('main.aiConfig', 'resolved', {
      source: cfgNow.tokenSource,
      hasToken: !!cfgNow.token,
      model: cfgNow.model,
      resourcesPath: process.resourcesPath || '',
    })
  } catch (e) {
    logger.warn('main.aiConfig', 'resolve failed: ' + (e as Error).message)
  }

  registerIpc()
  registerLogIpc()

  const boot = (): void => {
    createBallWindow()
    registerShortcut()
    applyAutoStart(store.get('autoStart') === true)
    startCursorPolling()
    startWatcher()
    setTimeout(() => {
      runSelfCheck({
        logWatcher: getLogWatcher(),
        onlineConfig,
        getOnlineToken: () => resolveOnline(store.get('aiConfig')).token,
        localLLM,
        tray: windows.tray,
        ballWindow: windows.ball,
        globalShortcut,
      }).catch((e) => logger.warn('selfCheck', 'run failed: ' + (e as Error).message))
    }, 5000)
  }

  // 首次启动（或协议版本升级）必须先同意用户协议/隐私政策
  if (needsConsent()) {
    logger.info('consent', 'required')
    createConsentWindow()
    createTray() // 托盘仍创建，方便用户从菜单退出
    ;(app as unknown as { once: (ev: string, fn: () => void) => void }).once('consent-accepted', () => {
      logger.info('consent', 'accepted, starting app')
      boot()
    })
    return
  }
  boot()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createBallWindow()
  })
})

// 全部窗口关闭时不退出（托盘应用）
app.on('window-all-closed', () => {
  logger.info('main.lifecycle', 'window-all-closed')
})

app.on('before-quit', () => {
  logger.info('main.lifecycle', 'before-quit')
  state.isQuitting = true
  flushPosition()
})

app.on('will-quit', () => {
  logger.info('main.lifecycle', 'will-quit')
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* ignore */
  }
  stopCursorPolling()
})
