// tray.ts - 托盘与菜单

import { app, dialog, Menu, nativeImage, shell, Tray } from 'electron'
import { logger } from './services/logger'
import { clearAll as clearAllLogs, getLevel, setLevel, getLogDir } from './services/logger'
import { state, windows } from './state'
import { createBallWindow, createNotebookWindow, createSettingsWindow, getDefaultPosition } from './windows'
import { openAiInputWindow } from './windows'
import { store } from './store'
import { ensureDailyDiary } from './remember'
import * as mail from './mail'
import { createMailWindow } from './mailWindow'
import { resourceFile } from './scripts'
import type { Persona } from '../shared/types'

// S0 仅猫；未来的皮肤在此扩展
export const PERSONAS: Record<Persona, string> = { cat: '猫' }

export function broadcastPersona(name: Persona): void {
  if (windows.ball && !windows.ball.isDestroyed()) {
    try {
      windows.ball.webContents.send('persona-changed', name)
    } catch {
      /* ignore */
    }
  }
}

export function applyAutoStart(enabled: boolean): void {
  if (!app.isPackaged) return // dev 模式不写注册表
  try {
    // 不要传 args：传 ['--hidden'] 在部分 Windows 版本上会变成 electron.exe --hidden 而无法启动
    app.setLoginItemSettings({ openAtLogin: !!enabled })
  } catch (e) {
    logger.warn('autoStart', `setLoginItemSettings failed: ${(e as Error).message}`)
  }
}

export function createTray(): void {
  let icon = nativeImage.createFromPath(resourceFile('tray.png'))
  if (icon.isEmpty()) icon = nativeImage.createEmpty()
  try {
    windows.tray = new Tray(icon)
  } catch (e) {
    logger.error('tray', `init failed: ${(e as Error).message}`)
    return
  }
  windows.tray.setToolTip('桌面陪伴 · 团子猫')
  rebuildTrayMenu()
}

export function rebuildTrayMenu(): void {
  if (!windows.tray) return
  const menu = Menu.buildFromTemplate([
    {
      label: '显示悬浮球',
      click: () => {
        logger.info('main.tray', 'show ball')
        const win = windows.ball && !windows.ball.isDestroyed() ? windows.ball : createBallWindow()
        win.show()
        win.focus()
      },
    },
    {
      label: '隐藏悬浮球',
      click: () => {
        logger.info('main.tray', 'hide all')
        if (windows.ball && !windows.ball.isDestroyed()) windows.ball.hide()
        if (windows.aiInput && !windows.aiInput.isDestroyed()) windows.aiInput.hide()
      },
    },
    { type: 'separator' },
    {
      label: '聊聊天',
      click: () => {
        const win = windows.ball && !windows.ball.isDestroyed() ? windows.ball : createBallWindow()
        win.show()
        win.focus()
        openAiInputWindow()
      },
    },
    { label: '猫的笔记本', click: () => { ensureDailyDiary(); createNotebookWindow() } },
    ...(mail.isBottleEnabled()
      ? [
          {
            label: '让猫出门看看',
            click: async () => {
              const r = await mail.patrolOnce()
              if (r.found) {
                logger.info('bottle.tray', 'picked one')
                if (windows.ball && !windows.ball.isDestroyed()) {
                  windows.ball.webContents.send('bottle-picked', { alias: r.alias })
                }
              } else {
                logger.info('bottle.tray', r.errorText || 'empty-handed')
              }
            },
          },
          { label: '许愿瓶...', click: () => createMailWindow() },
        ]
      : []),
    { label: '设置...', click: () => createSettingsWindow() },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: store.get('autoStart') === true,
      enabled: app.isPackaged,
      click: (item) => {
        store.set('autoStart', item.checked)
        applyAutoStart(item.checked)
      },
    },
    {
      label: '桌面形象',
      submenu: Object.entries(PERSONAS).map(([key, label]) => ({
        label,
        type: 'radio' as const,
        checked: (store.get('persona') || 'cat') === key,
        click: () => {
          const p = key as Persona
          store.set('persona', p)
          logger.info('persona', 'tray set ' + p)
          broadcastPersona(p)
          rebuildTrayMenu()
        },
      })),
    },
    {
      label: '重置位置',
      click: () => {
        logger.info('main.tray', 'reset position')
        store.set('position', null)
        if (windows.ball && !windows.ball.isDestroyed()) {
          const pos = getDefaultPosition()
          windows.ball.setPosition(pos.x, pos.y)
          store.set('position', pos)
        }
      },
    },
    { type: 'separator' },
    {
      label: '日志级别',
      submenu: [
        { label: 'info（全部）', type: 'radio', checked: getLevel() === 'info', click: () => { setLevel('info'); rebuildTrayMenu() } },
        { label: 'warn', type: 'radio', checked: getLevel() === 'warn', click: () => { setLevel('warn'); rebuildTrayMenu() } },
        { label: 'error', type: 'radio', checked: getLevel() === 'error', click: () => { setLevel('error'); rebuildTrayMenu() } },
      ],
    },
    {
      label: '打开日志文件夹',
      click: () => {
        try {
          void shell.openPath(getLogDir())
        } catch {
          /* ignore */
        }
      },
    },
    {
      label: '清空日志',
      click: async () => {
        const { response } = await dialog.showMessageBox({
          type: 'question',
          buttons: ['取消', '清空'],
          defaultId: 0,
          cancelId: 0,
          title: '清空日志',
          message: '确定清空所有日志？',
        })
        if (response === 1) {
          clearAllLogs()
          logger.info('main', 'logs cleared')
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        state.isQuitting = true
        app.quit()
      },
    },
  ])
  windows.tray.setContextMenu(menu)
}
