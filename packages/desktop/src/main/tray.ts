// tray.ts - 托盘与菜单

import { app, dialog, Menu, nativeImage, shell, Tray } from 'electron'
import { logger } from './services/logger'
import { clearAll as clearAllLogs, getLevel, setLevel, getLogDir } from './services/logger'
import { state, windows } from './state'
import { createBallWindow, createNotebookWindow, createSettingsWindow } from './windows'
import { EV } from '../shared/channels'
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

/**
 * 把猫移回默认位置。
 * 猫的位置由渲染端的 transform 决定，ballWindow 是全屏覆盖层——**绝不能 setPosition**，
 * 那会把整层移出屏幕，看起来像「猫丢了」。
 * 正确做法：清空存档 + 通知渲染端重置。
 */
export function resetBallPosition(source: 'tray' | 'debug' = 'tray'): void {
  logger.info('main.reset', 'position reset (' + source + ')')
  store.set('position', null)
  if (windows.ball && !windows.ball.isDestroyed()) {
    windows.ball.webContents.send(EV.resetBall)
  }
}

export function createTray(): void {
  const iconPath = resourceFile('tray.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    // 不能静默失败：托盘没图标时用户会以为应用没启动。至少留下原因。
    logger.error('tray', `icon load failed: ${iconPath}`)
    // 退回到应用图标（256px），它一定在 resources/ 里
    const fallback = nativeImage.createFromPath(resourceFile('icon-sm.png'))
    icon = fallback.isEmpty() ? nativeImage.createEmpty() : fallback
  }
  try {
    windows.tray = new Tray(icon)
  } catch (e) {
    logger.error('tray', `init failed: ${(e as Error).message}`)
    return
  }
  windows.tray.setToolTip('桌面陪伴 · 团子猫')
  logger.info('tray', `created (${icon.isEmpty() ? 'EMPTY ICON' : 'ok'})`)
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
      click: () => resetBallPosition('tray'),
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
