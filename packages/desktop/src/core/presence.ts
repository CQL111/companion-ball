// presence.ts - 「你在不在」与久坐计时（领域层，零平台依赖）
// 平台层（Electron 的 powerMonitor）把系统空闲秒数喂进来，这里只做纯判断：
//   - 多久算「离开」
//   - 离开多久算「很久」（回来时它会闷一下）
//   - 连续使用多久算「久坐」，以及多久提醒一次
//
// 隐私边界：只使用「空闲时长」这个数字，不读窗口标题、不截屏、不采集任何内容。

/** 空闲超过这个时长算离开（锁屏 / 挂机） */
export const AWAY_AFTER_MS = 5 * 60 * 1000
/** 离开超过这个时长，回来时它先「闷」一下（与 petState.SULK_AFTER_MS 对齐） */
export const LONG_AWAY_MS = 2 * 60 * 60 * 1000
/**
 * 连续使用多久提醒一次久坐。
 * 这个值同时也是「首次提醒的宽限」——两个不同的数字只会互相冲突，
 * 所以只保留一个：坐满 50 分钟就提醒，之后每次坐满 50 分钟再提醒（有冷却与每日上限）。
 */
export const SIT_REMIND_INTERVAL_MS = 50 * 60 * 1000
/** 两次提醒之间至少间隔（防止频繁打断） */
export const SIT_REMIND_COOLDOWN_MS = 50 * 60 * 1000
/** 每个自然日最多提醒几次 */
export const SIT_REMIND_DAILY_MAX = 3

export interface PresenceOptions {
  awayAfterMs?: number
  sitIntervalMs?: number
  sitCooldownMs?: number
  sitDailyMax?: number
}

export const DEFAULT_PRESENCE: Required<PresenceOptions> = {
  awayAfterMs: AWAY_AFTER_MS,
  sitIntervalMs: SIT_REMIND_INTERVAL_MS,
  sitCooldownMs: SIT_REMIND_COOLDOWN_MS,
  sitDailyMax: SIT_REMIND_DAILY_MAX,
}

export type Presence = 'active' | 'away'

/** 系统空闲时长 → 在不在 */
export function presenceOf(idleMs: number, opts: PresenceOptions = {}): Presence {
  const awayAfter = opts.awayAfterMs ?? AWAY_AFTER_MS
  return idleMs >= awayAfter ? 'away' : 'active'
}

// ---------- 离开/回来 的转移（纯函数） ----------
//
// 为什么需要它：离开/回来的判断散在平台层会有两个坑，而且都真实发生过——
//   1. 系统睡眠（合盖 / 息屏）时事件循环被冻结，「空闲超时」那条路根本不会跑；
//      醒来后 getSystemIdleTime() 从 0 重新计，离开时长会被算成几十秒。
//   2. 状态没有单一 owner：睡着了没标记离开，回来时 markBack() 早退，一个事件都不发。
// 现在所有入口（轮询 / 锁屏 / suspend / resume）都走同一组转移，平台层只负责喂事件。

export interface AbsenceSample {
  active: boolean
  /** 离开起点（active 时无意义） */
  awaySince: number
}

export type AbsenceEvent =
  | { type: 'away'; awayStart: number }
  | { type: 'back'; awayStart: number; awayMs: number }

export interface AbsenceStep {
  next: AbsenceSample
  /** null = 状态没变，什么都不用做 */
  event: AbsenceEvent | null
}

function toAway(prev: AbsenceSample, awayStart: number): AbsenceStep {
  if (!prev.active) return { next: prev, event: null }
  return { next: { active: false, awaySince: awayStart }, event: { type: 'away', awayStart } }
}

function toBack(prev: AbsenceSample, now: number): AbsenceStep {
  if (prev.active) return { next: prev, event: null }
  return {
    next: { active: true, awaySince: 0 },
    event: { type: 'back', awayStart: prev.awaySince, awayMs: Math.max(0, now - prev.awaySince) },
  }
}

/** 轮询：用系统空闲时长判断。这是常规路径（空闲 5 分钟算离开）。 */
export function sampleAbsence(
  prev: AbsenceSample,
  sample: { now: number; idleMs: number },
  opts: PresenceOptions = {},
): AbsenceStep {
  if (presenceOf(sample.idleMs, opts) === 'away') return toAway(prev, sample.now)
  return toBack(prev, sample.now)
}

/**
 * 系统挂起（合盖 / 息屏 / 睡眠）。
 * 用「收到事件的时间」作为离开起点——挂起后没有下一次 tick 了，
 * 此刻就是它看到的最后一眼。
 */
export function suspendAbsence(prev: AbsenceSample, at: number): AbsenceStep {
  return toAway(prev, at)
}

/**
 * 系统唤醒。
 * **必须用唤醒时刻反推离开起点**，不能用 now - awaySince：
 * 睡眠期间 getSystemIdleTime() 已经清零，用它算出来的「离开时长」是假的。
 */
export function resumeAbsence(prev: AbsenceSample, at: number): AbsenceStep {
  return toBack(prev, at)
}

/** 这次回来是否算「离开很久」 */
export function isLongAway(awayMs: number): boolean {
  return awayMs >= LONG_AWAY_MS
}

// ---------- 久坐计时 ----------
export interface SitState {
  /** 本轮连续使用的起点（离开或提醒重置后会变） */
  since: number
  /** 上次提醒的时间（0 = 还没提醒过） */
  lastRemindAt: number
  /** 当日已提醒次数 */
  todayCount: number
  /** 计数所属的本地日期 */
  day: string
}

export type SitEvent =
  | { type: 'active'; now: number }
  | { type: 'away'; now: number }
  | { type: 'reminded'; now: number; day: string }

export interface SitCheck {
  shouldRemind: boolean
  reason?: 'interval' | 'cooldown' | 'daily-limit' | 'not-yet'
}

export function initSit(now: number, day: string): SitState {
  return { since: now, lastRemindAt: 0, todayCount: 0, day }
}

/** 本地日期键（与日记一致：YYYY-MM-DD） */
export function dayKey(now: number): string {
  const d = new Date(now)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${dd}`
}

/**
 * 推进久坐状态。
 * 关键取舍：**离开会重置计时**——离开十分钟回来，连续使用并不连续。
 */
export function reduceSit(
  state: SitState,
  event: SitEvent,
  opts: PresenceOptions = {},
): SitState {
  const o = { ...DEFAULT_PRESENCE, ...opts }
  if (event.type === 'away') {
    return { ...state, since: event.now, lastRemindAt: 0 }
  }
  if (event.type === 'reminded') {
    const day = event.day
    const sameDay = state.day === day
    return {
      ...state,
      lastRemindAt: event.now,
      todayCount: sameDay ? state.todayCount + 1 : 1,
      day,
    }
  }
  // active：只处理跨天重置
  const today = dayKey(event.now)
  if (state.day !== today) return { ...state, day: today, todayCount: 0 }
  return state
}

/** 是否该提醒久坐（纯判断，不改状态） */
export function sitCheck(state: SitState, now: number, opts: PresenceOptions = {}): SitCheck {
  const o = { ...DEFAULT_PRESENCE, ...opts }
  const elapsed = now - state.since

  if (elapsed < o.sitIntervalMs) return { shouldRemind: false, reason: 'not-yet' }
  if (state.lastRemindAt && now - state.lastRemindAt < o.sitCooldownMs) {
    return { shouldRemind: false, reason: 'cooldown' }
  }
  if (state.todayCount >= o.sitDailyMax) return { shouldRemind: false, reason: 'daily-limit' }
  return { shouldRemind: true, reason: 'interval' }
}

/** 久坐提醒的文案：不过度关心，也不说教 */
export const SIT_REMIND_LINES = [
  '你坐了好一会儿了，起来动动？',
  '要不要喝口水。',
  '我陪你站起来伸个懒腰。',
  '肩膀放下来一点。',
  '窗边透透气吧。',
]

/** 选一句提醒（按次数轮换，避免每次一样） */
export function pickSitLine(count: number): string {
  return SIT_REMIND_LINES[count % SIT_REMIND_LINES.length] ?? SIT_REMIND_LINES[0]!
}
