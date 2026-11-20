// state.ts - 主进程运行期可变状态
// state 持有坐标 / 热区 / 标志；窗口引用放在 windows.ts（有循环依赖的模块都从这里取，避免互相 import）

import type { BrowserWindow, Tray } from 'electron'
import type { Position, Rect } from '../shared/types'

export const BALL_SIZE = 80
export const BALL_HALO = 40
export const AI_INPUT_WIDTH = 380
export const AI_INPUT_HEIGHT = 480

export const state = {
  isQuitting: false,
  startHidden: process.argv.includes('--hidden'),
  /** 球在 transform 坐标里的当前位置 */
  currentBallPos: { x: 0, y: 0 } as Position,
  /** 菜单打开时渲染端上报的「猫 + 面板」外接矩形（窗口内坐标） */
  ballHitRegion: null as Rect | null,
  lastIgnoreState: null as boolean | null,
  lastPersistedPos: null as Position | null,
  positionSaveTimer: null as NodeJS.Timeout | null,
  cursorPollTimer: null as NodeJS.Timeout | null,
}

export const windows: {
  ball: BrowserWindow | null
  settings: BrowserWindow | null
  aiInput: BrowserWindow | null
  consent: BrowserWindow | null
  legal: BrowserWindow | null
  tray: Tray | null
} = {
  ball: null,
  settings: null,
  aiInput: null,
  consent: null,
  legal: null,
  tray: null,
}
