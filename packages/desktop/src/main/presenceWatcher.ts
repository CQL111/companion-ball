// presenceWatcher.ts - 主进程侧：读系统空闲状态，推送「离开 / 回来 / 久坐」
// 隐私：只用 powerMonitor.getSystemIdleTime() 这个秒数 + 锁屏 / 睡眠事件。
// 不读窗口标题、不截屏、不做键盘记录。
//
// 离开 / 回来有三个入口，曾经各写各的，结果两条真实故障：
//   1. 只有「空闲 5 分钟」和「锁屏」——合盖休眠时事件循环冻结，一个事件都不发
//   2. 醒来后 getSystemIdleTime() 从 0 重计，离开时长会被算成几十秒
// 现在统一走 core/presence 的 sampleAbsence / suspendAbsence / resumeAbsence，
// 这里是唯一的状态 owner（之前的 locked 标志会让三条路径互相打架）。

import { powerMonitor } from 'electron'
import * as absence from '../core/absence'
import {
  AWAY_AFTER_MS,
  dayKey,
  initSit,
  reduceSit,
  resumeAbsence,
  sampleAbsence,
  sitCheck,
  suspendAbsence,
  type AbsenceStep,
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
/** 锁屏且尚未解锁：系统空闲秒数在锁屏时不一定增长，强制算离开 */
let locked = false
/** 系统挂起中：期间没有 tick，醒来由 resume 收尾 */
let suspended = false

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
  // 恢复上次的离开起点：进程可能在离开期间被杀/重启（更新、崩溃），
  // 若这里当「一直在」，那一段缺席就永远不会被结算，P1 日记会漏掉。
  const resumeAway = store.get('awaySince') || 0
  state = resumeAway
    ? { active: false, awaySince: resumeAway, sit: initSit(now, dayKey(now)) }
    : { active: true, awaySince: 0, sit: initSit(now, dayKey(now)) }
  if (resumeAway) logger.info('presence.watcher', `resuming away since ${new Date(resumeAway).toISOString()}`)
  logger.info('presence.watcher', 'started')

  // 锁屏：立即视为离开。解锁时才算回来（见下方 unlock-screen）。
  powerMonitor.on('lock-screen', () => {
    locked = true
    if (state) apply(sampleAway(state, Date.now()), 'locked')
  })
  powerMonitor.on('unlock-screen', () => {
    locked = false
    // 解锁 = 用户人已经回来了（输了密码）。立即标记回来，不等下一轮轮询——
    // 否则要等最多 30 秒，用户会觉得「它没注意到我」。
    if (state) apply(resumeAbsence(state, Date.now()), 'unlock')
  })

  // 系统睡眠（合盖 / 现代待机 / 息屏休眠）：事件循环会被冻结，
  // 轮询那条路走不到，只能靠这两个事件。
  powerMonitor.on('suspend', () => {
    suspended = true
    if (state) apply(suspendAbsence(state, Date.now()), 'suspend')
  })
  powerMonitor.on('resume', () => {
    suspended = false
    // 唤醒时锁屏界面还在，用户还没输密码。此刻说「你回来了」，
    // 气泡会在锁屏后面亮一下就消失——等于没说。
    // 所以锁屏中唤醒只恢复计时，真正的「回来」交给 unlock-screen。
    if (locked) {
      logger.info('presence.watcher', 'resume while locked, waiting for unlock')
      return
    }
    // 离开起点用挂起时刻反推（见 resumeAbsence），不信任唤醒后归零的空闲秒数
    if (state) apply(resumeAbsence(state, Date.now()), 'resume')
  })

  timer = setInterval(tick, POLL_MS)
}

export function stopPresenceWatcher(): void {
  if (timer) clearInterval(timer)
  timer = null
  logger.info('presence.watcher', 'stopped')
}

/** 锁屏路径：当前状态 + 现在离开 */
function sampleAway(prev: PresenceState, at: number): AbsenceStep {
  return suspendAbsence(prev, at)
}

/** 应用一次转移；这是唯一会改 state / 落盘 / 发事件的地方。 */
function apply(step: AbsenceStep, source: string): void {
  if (!state || !step.event) return
  const now = Date.now()

  if (step.event.type === 'away') {
    state.active = false
    state.awaySince = step.event.awayStart
    state.sit = reduceSit(state.sit, { type: 'away', now: step.event.awayStart })
    // P1：记下离开起点。只有 8 小时以上才会被日记采用（判断在 core/absence.ts）。
    store.set('awaySince', step.event.awayStart)
    send('presence-away', { since: step.event.awayStart })
    logger.info('presence.watcher', `away (${source})`)
    return
  }

  // back
  state.active = true
  state.awaySince = 0
  state.sit = { ...state.sit, since: now, lastRemindAt: 0 }
  const awayMs = step.event.awayMs
  logger.info('presence.watcher', `back (${source}) after ${Math.round(awayMs / 60000)}min`)
  send('presence-back', { awayMs })

  // P1：长时间离开 → 写进当天日记（纯本地模板，零 token）
  // 离开起点取转移事件本身的值——它和时长是同一时刻算出来的，
  // 用 store 里的值可能来自上一段缺席（例如「记下起点后进程被杀、重启后回来」）。
  const awayStart = step.event.awayStart
  if (awayStart) {
    if (absence.shouldRecordAbsence(awayMs)) void recordAbsenceDiary(awayStart, now)
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

  // 挂起中：事件循环被冻结，醒来由 resume 收尾
  if (suspended) return

  const idleMs = powerMonitor.getSystemIdleTime() * 1000

  // 锁屏中：不信任空闲秒数（锁屏时它不一定增长），保持离开等 unlock。
  // 容错：若 unlock 事件漏了，空闲秒数会告诉我们人其实已经在了——清掉标志，
  // 否则锁屏标志一卡住，久坐提醒和离开判断就永久停摆。
  if (locked) {
    if (idleMs < AWAY_AFTER_MS) locked = false
    else return
  }

  apply(sampleAbsence(state, { now, idleMs }), 'poll')

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
