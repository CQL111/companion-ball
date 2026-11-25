// shortcut.ts - 全局快捷键

import { globalShortcut } from 'electron'
import { logger } from './services/logger'
import { windows } from './state'
import { createBallWindow, openAiInputWindow } from './windows'

export function registerShortcut(): void {
  try {
    const ok = globalShortcut.register('CommandOrControl+Alt+F', () => {
      const win = windows.ball && !windows.ball.isDestroyed() ? windows.ball : createBallWindow()
      win.show()
      win.focus()
      openAiInputWindow()
    })
    if (!ok) logger.warn('shortcut', 'Ctrl+Alt+F 已被其他应用占用，全局快捷键不可用')
    else logger.info('shortcut', 'Ctrl+Alt+F registered')
  } catch (e) {
    logger.warn('shortcut', `register failed: ${(e as Error).message}`)
  }
}
