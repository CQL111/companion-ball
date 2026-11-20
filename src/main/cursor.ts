// cursor.ts - 主进程轮询光标位置，独立决策点击穿透
// 不依赖 renderer 的 mousemove（避免 forwarded 事件丢失/延迟）

import { screen } from 'electron'
import { BALL_HALO, BALL_SIZE, state, windows } from './state'
import { logger } from './services/logger'

export function startCursorPolling(): void {
  if (state.cursorPollTimer) return
  logger.info('main.cursorPolling', 'started')
  state.cursorPollTimer = setInterval(() => {
    const win = windows.ball
    if (!win || win.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    // 球屏幕坐标 = 窗口原点 + transform 坐标
    const ballLeft = bounds.x + state.currentBallPos.x - BALL_HALO
    const ballRight = bounds.x + state.currentBallPos.x + BALL_SIZE + BALL_HALO
    const ballTop = bounds.y + state.currentBallPos.y - BALL_HALO
    const ballBottom = bounds.y + state.currentBallPos.y + BALL_SIZE + BALL_HALO
    let isOver =
      cursor.x >= ballLeft && cursor.x <= ballRight && cursor.y >= ballTop && cursor.y <= ballBottom

    // 菜单打开：光标在「猫 + 面板」矩形内也继续接收鼠标
    if (!isOver && state.ballHitRegion) {
      const r = state.ballHitRegion
      const rx = bounds.x + r.x
      const ry = bounds.y + r.y
      isOver = cursor.x >= rx && cursor.x <= rx + r.w && cursor.y >= ry && cursor.y <= ry + r.h
    }

    const shouldIgnore = !isOver
    if (state.lastIgnoreState !== shouldIgnore) {
      state.lastIgnoreState = shouldIgnore
      win.setIgnoreMouseEvents(shouldIgnore)
    }
  }, 80)
}

export function stopCursorPolling(): void {
  if (state.cursorPollTimer) clearInterval(state.cursorPollTimer)
  state.cursorPollTimer = null
}
