// mailWindow.ts - 许愿瓶界面窗口（写纸条 / 读纸条 / 回一句）
// 猫「出门」的动画在宠物窗口里；这里只处理文字交互。

import { BrowserWindow } from 'electron'
import { windows } from './state'
import { preloadPath, rendererFile } from './scripts'
import { logger } from './services/logger'

export function createMailWindow(): BrowserWindow {
  if (windows.mail && !windows.mail.isDestroyed()) {
    windows.mail.show()
    windows.mail.focus()
    return windows.mail
  }
  const win = new BrowserWindow({
    width: 420,
    height: 560,
    minWidth: 360,
    minHeight: 420,
    transparent: false,
    frame: true,
    title: '许愿瓶',
    backgroundColor: '#141019',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath },
  })
  windows.mail = win
  win.setMenuBarVisibility(false)
  win.loadFile(rendererFile('mail'))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    windows.mail = null
    logger.info('mail.window', 'closed')
  })
  return win
}
