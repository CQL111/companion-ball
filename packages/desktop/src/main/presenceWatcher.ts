// presenceWatcher.ts - 主进程侧：读系统空闲状态，推送「离开 / 回来 / 久坐」
// 隐私：只用 powerMonitor.getSystemIdleTime() 这个秒数 + 锁屏事件。
// 不读窗口标题、不截屏、不做键盘记录。

import { powerMonitor } from 'electron'
import * as absence from '../core/absence'
import {
  dayKey,
  initSit,
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
  // P1：记下离开起点。只有 8 小时以上才会被日记采用（判断在 core/absence.ts）。
  store.set('awaySince', now)
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

  // P1：长时间离开 → 写进当天日记（纯本地模板，零 token）
  const awayStart = store.get('awaySince') ?? 0
  if (awayStart) {
    if (absence.shouldRecordAbsence(now - awayStart)) void recordAbsenceDiary(awayStart, now)
    store.set('awaySince', 0)
  }
}

/** 把一段缺席写进当天日记。失败只记 warn，不影响任何用户可见流程。 */
async function recordAbsenceDiary(awayStart: number, awayEnd: number): Promise<void> {
  try {
    const { currentWeatherSnapshot } = await import('./weatherService')
    const snap = currentWeatherSnapshot()
    const kind = snap?.kind
    const weather = kind === 'rain' || kind === 'snow' || kind === 'storm' || kind === 'fog' ? kind : 'none'

    const lines = absence.buildAbsenceLines({ input: { awayStart, awayEnd, weather } })
    if (!lines.length) return

    const { ensureAbsenceDiary } = await import('./remember')
    ensureAbsenceDiary(lines, awayEnd)
    logger.info(
      'notebook.absence',
      `wrote ${lines.length} lines after ${Math.round((awayEnd - awayStart) / 3600000)}h`,
    )
  } catch (e) {
    logger.warn('notebook.absence', `failed: ${(e as Error).message}`)
  }
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

  // 只发送事实（坐了多少分钟），文案由渲染端统一按「观察 → 台词」生成。
  // 不在主进程烘焙文案：否则久坐说的话会和其他渠道（需求 / 天气）的口气分裂。
  const minutes = Math.max(1, Math.round((now - state.sit.since) / 60000))
  const count = state.sit.todayCount + 1
  state.sit = reduceSit(state.sit, { type: 'reminded', now, day: dayKey(now) })
  logger.info('presence.sit', `remind #${count} after ${minutes}min`)
  send('presence-sit', { minutes, count })
}
