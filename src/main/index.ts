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
import { ensureDailyDiary } from './remember'
import * as mail from './mail'

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
    // S2：启动时补写今天的日记，之后每小时检查一次（跨天/长时间运行）
    ensureDailyDiary()
    setInterval(() => ensureDailyDiary(), 60 * 60 * 1000)
    // S3：猫自己出门巡游（开启许愿瓶后才有意义）
    startBottlePatrol()
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

// ---------- 许愿瓶：猫的自动巡游 ----------
// 每 10 分钟看一次是否该出门；节奏与概率在 core/mailbox.shouldGoOut 里，
// 这里只负责「到点了就问一次服务端」以及把结果写进笔记本。
function startBottlePatrol(): void {
  if (!mail.isBottleEnabled()) return
  logger.info('bottle.patrol', 'started')
  setInterval(async () => {
    try {
      if (!mail.isBottleEnabled()) return
      const r = await mail.catGoesOut()
      if (r.ok && r.data) {
        mail.noteBottleInNotebook('picked', r.data.body, r.data.alias)
        logger.info('bottle.patrol', 'brought one back')
        // 通知渲染端：猫可以演「叼回纸条」
        if (windows.ball && !windows.ball.isDestroyed()) {
          windows.ball.webContents.send('bottle-picked', { alias: r.data.alias })
        }
      }
    } catch (e) {
      logger.warn('bottle.patrol', `failed: ${(e as Error).message}`)
    }
  }, 10 * 60 * 1000)
}

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
