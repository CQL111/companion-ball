// presenceWatcher.ts - 主进程侧：读系统空闲状态，推送「离开 / 回来 / 久坐」
// 隐私：只用 powerMonitor.getSystemIdleTime() 这个秒数 + 锁屏事件。
// 不读窗口标题、不截屏、不做键盘记录。

import { powerMonitor } from 'electron'
import {
  dayKey,
  initSit,
  pickSitLine,
  presenceOf,
  reduceSit,
  sitCheck,
  type SitState,
} from '../core/presence'
import { logger } from './services/logger'
import { windows } from './state'
import { store } from './store'

const POLL_MS = 30_000

/** 久坐开关（默认开，可在设置里关） */
export function sitReminderEnabled(): boolean {
  return store.get('sitReminder') !== false
}

export function setSitReminderEnabled(enabled: boolean): void {
  store.set('sitReminder', enabled !== false)
}

interface PresenceState {
  active: boolean
  awaySince: number
  sit: SitState
}

let state: PresenceState | null = null
let timer: NodeJS.Timeout | null = null
let locked = false

function ball() {
  const w = windows.ball
  return w && !w.isDestroyed() ? w : null
}

function send(channel: string, payload: unknown): void {
  ball()?.webContents.send(channel, payload)
}

/** 开始轮询。重复调用无副作用。 */
export function startPresenceWatcher(): void {
  if (timer) return
  const now = Date.now()
  state = { active: true, awaySince: 0, sit: initSit(now, dayKey(now)) }
  logger.info('presence.watcher', 'started')

  // 锁屏：立即视为离开（系统空闲秒数在锁屏时不一定立刻增长）
  powerMonitor.on('lock-screen', () => {
    locked = true
    markAway()
    logger.info('presence.watcher', 'screen locked')
  })
  powerMonitor.on('unlock-screen', () => {
    locked = false
    // 等下一轮轮询判断是否真的回来，避免解锁瞬间状态抖动
    logger.info('presence.watcher', 'screen unlocked')
  })

  timer = setInterval(tick, POLL_MS)
}

export function stopPresenceWatcher(): void {
  if (timer) clearInterval(timer)
  timer = null
  logger.info('presence.watcher', 'stopped')
}

function markAway(): void {
  if (!state || !state.active) return
  const now = Date.now()
  state.active = false
  state.awaySince = now
  state.sit = reduceSit(state.sit, { type: 'away', now })
  send('presence-away', { since: now })
}

function markBack(): void {
  if (!state || state.active) return
  const now = Date.now()
  const awayMs = state.awaySince ? now - state.awaySince : 0
  state.active = true
  state.awaySince = 0
  state.sit = { ...state.sit, since: now, lastRemindAt: 0 }
  logger.info('presence.watcher', `back after ${Math.round(awayMs / 60000)}min`)
  send('presence-back', { awayMs })
}

function tick(): void {
  if (!state) return
  const now = Date.now()
  const idleSec = powerMonitor.getSystemIdleTime()
  const idleMs = idleSec * 1000
  const p = presenceOf(idleMs)

  // 锁屏期间强制算离开
  if (locked || p === 'away') {
    markAway()
    return
  }
  markBack()

  if (!sitReminderEnabled()) return

  state.sit = reduceSit(state.sit, { type: 'active', now })
  const check = sitCheck(state.sit, now)
  if (!check.shouldRemind) return

  // 提醒：气泡 + 台词，不抢焦点
  const line = pickSitLine(state.sit.todayCount)
  state.sit = reduceSit(state.sit, { type: 'reminded', now, day: dayKey(now) })
  logger.info('presence.sit', `remind #${state.sit.todayCount}`)
  send('presence-sit', { text: line, count: state.sit.todayCount })
}
