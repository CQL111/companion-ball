// petState.ts - 团子猫情绪状态机（领域层，零平台依赖）
// 纯函数：输入「当前状态 + 事件 + 时间」，输出「新状态 + 可选的触发类型」。
// 不读系统时间、不碰 DOM —— 时钟与事件由平台层传入，这样桌面端与手机端可以共用。
//
// 设计要点（对应 docs/ROADMAP.md S1）：
// - 微交互不走 LLM：所有反应在本函数内即时完成
// - 状态机只输出抽象动作（mood + trigger），不输出动画；怎么渲染是平台的事
// - 被打扰要有代价：连续点击会不耐烦，快速甩放会眩晕

export type PetMood =
  | 'neutral' // 醒着，平静
  | 'smile' // 开心 / 打招呼
  | 'curious' // 被注视、被拖起
  | 'doze' // 打盹（半睡）
  | 'sleep' // 睡着
  | 'annoyed' // 被连点烦到
  | 'dizzy' // 被甩晕
  | 'sulk' // 你离开很久，它有点闷（不是生气，是等你）

/** 触发类型：决定用哪组台词，也方便平台层做额外反馈（音效/动画） */
export type PetTrigger = 'tap' | 'wake' | 'morning' | 'annoyed' | 'dizzy' | 'return'

export interface PetState {
  mood: PetMood
  /** 上次与猫交互的时间戳（ms） */
  lastInteractAt: number
  /** 上次说早安的本地日期（YYYY-MM-DD）；每天只问候一次 */
  lastGreetDate: string
  /** 最近 10 秒内的点击时间戳，用于识别「连点」 */
  clicks: number[]
  dragging: boolean
  /** 临时情绪：在 until 之前保持该 mood，到期后回到 idle 推导的 mood */
  hold: { mood: PetMood; until: number } | null
}

export type PetEvent =
  | { type: 'tick'; now: number }
  | { type: 'pointer-enter'; now: number }
  | { type: 'pointer-leave'; now: number }
  | { type: 'click'; now: number }
  | { type: 'drag-start'; now: number }
  | { type: 'drag-end'; now: number; flung: boolean }
  /** 系统报告用户离开了（空闲 / 锁屏超过阈值） */
  | { type: 'away'; now: number; awayMs: number }
  /** 用户回来了 */
  | { type: 'returned'; now: number; awayMs: number }

export interface PetStateOptions {
  /** 无交互多久进入打盹（默认 30 分钟） */
  napAfterMs?: number
  /** 无交互多久睡着（默认 60 分钟） */
  sleepAfterMs?: number
  /** 连点判定窗口（默认 10 秒） */
  clickWindowMs?: number
  /** 连点多少次判定为不耐烦（默认 5 次） */
  annoyedClicks?: number
  /** 早安时段（本地小时，闭开区间）：默认 [6, 10) */
  morningHours?: [number, number]
}

export const DEFAULT_OPTIONS: Required<PetStateOptions> = {
  napAfterMs: 30 * 60 * 1000,
  sleepAfterMs: 60 * 60 * 1000,
  clickWindowMs: 10 * 1000,
  annoyedClicks: 5,
  morningHours: [6, 10],
}

/** 离开超过这个时长，回来时它先「闷」一下（不是生气） */
export const SULK_AFTER_MS = 2 * 60 * 60 * 1000

const HOLD_MS = {
  smile: 3000,
  curious: 3000,
  annoyed: 6000,
  dizzy: 1800,
  sulk: 5000,
}

/** 本地日期键（YYYY-MM-DD），用于「每天只问候一次」 */
export function dateKey(now: number): string {
  const d = new Date(now)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function initPetState(now = 0): PetState {
  return { mood: 'neutral', lastInteractAt: now, lastGreetDate: '', clicks: [], dragging: false, hold: null }
}

/** 由「当前时间 + 上次交互时间」推导出的基础情绪 */
export function idleMood(state: PetState, now: number, opts: Required<PetStateOptions> = DEFAULT_OPTIONS): PetMood {
  const since = Math.max(0, now - state.lastInteractAt)
  if (since >= opts.sleepAfterMs) return 'sleep'
  if (since >= opts.napAfterMs) return 'doze'
  const hour = new Date(now).getHours()
  // 深夜即便刚交互过也半睡（不主动出声是另一层策略，这里只管表现）
  if (hour < 6) return 'doze'
  return 'neutral'
}

function isMorning(now: number, opts: Required<PetStateOptions>): boolean {
  const h = new Date(now).getHours()
  const [from, to] = opts.morningHours
  return h >= from && h < to
}

export interface ReduceResult {
  state: PetState
  /** 本次事件产生的触发类型（无则不返回） */
  trigger?: PetTrigger
}

/**
 * 状态转移。返回新对象，不修改入参。
 * 调用方负责：
 *  - 每秒发一次 {type:'tick'}
 *  - pointerleave 后约 2 秒再发一次 {type:'pointer-leave'}（用于从 curious 落回）
 */
export function reducePetState(
  state: PetState,
  event: PetEvent,
  opts: Required<PetStateOptions> = DEFAULT_OPTIONS,
): ReduceResult {
  const now = event.now

  // 临时情绪未到期：只处理会打断它的事件（连点、拖动），否则保持
  if (event.type === 'tick') {
    if (state.hold && now < state.hold.until) return { state }
    const mood = state.dragging ? 'curious' : idleMood(state, now, opts)
    if (mood === state.mood && !state.hold) return { state }
    return { state: { ...state, mood, hold: null } }
  }

  if (event.type === 'drag-start') {
    return { state: { ...state, dragging: true, mood: 'curious', hold: null, lastInteractAt: now } }
  }

  if (event.type === 'away') {
    // 用户离开了：猫自己待着。离开很久会「闷」，但不是生气——它是在等你
    const sulk = event.awayMs >= SULK_AFTER_MS
    return {
      state: {
        ...state,
        dragging: false,
        lastInteractAt: now,
        // 离开时它自己会睡着；回来时由 returned 事件负责唤醒
        mood: sulk ? 'sulk' : 'doze',
        hold: null,
      },
    }
  }

  if (event.type === 'returned') {
    // 用户回来了：短时间离开 → 抬头看你；很久 → 先闷一下再亲近
    if (event.awayMs >= SULK_AFTER_MS) {
      return {
        state: {
          ...state,
          lastInteractAt: now,
          mood: 'sulk',
          hold: { mood: 'sulk', until: now + HOLD_MS.sulk },
        },
        trigger: 'return',
      }
    }
    return {
      state: {
        ...state,
        lastInteractAt: now,
        mood: 'curious',
        hold: { mood: 'curious', until: now + HOLD_MS.curious },
      },
      trigger: 'return',
    }
  }

  if (event.type === 'drag-end') {
    if (event.flung) {
      return {
        state: {
          ...state,
          dragging: false,
          mood: 'dizzy',
          hold: { mood: 'dizzy', until: now + HOLD_MS.dizzy },
          lastInteractAt: now,
        },
        trigger: 'dizzy',
      }
    }
    return { state: { ...state, dragging: false, mood: 'curious', hold: { mood: 'curious', until: now + HOLD_MS.curious } } }
  }

  if (event.type === 'pointer-leave') {
    // 落回基础情绪（若临时情绪仍在，则保持不变）
    if (state.hold && now < state.hold.until) return { state }
    return { state: { ...state, mood: idleMood(state, now, opts), hold: null } }
  }

  if (event.type === 'pointer-enter') {
    // 从睡 / 打盹里被唤醒
    if (state.mood === 'sleep' || state.mood === 'doze') {
      return {
        state: { ...state, mood: 'curious', hold: { mood: 'curious', until: now + HOLD_MS.curious }, lastInteractAt: now },
        trigger: 'wake',
      }
    }
    if (state.mood === 'annoyed' && state.hold && now < state.hold.until) return { state }
    return {
      state: { ...state, mood: 'curious', hold: { mood: 'curious', until: now + HOLD_MS.curious }, lastInteractAt: now },
    }
  }

  // click
  const clicks = [...state.clicks.filter((t) => now - t <= opts.clickWindowMs), now]
  const base = { ...state, clicks, lastInteractAt: now }

  // 不耐烦期间继续被点：保持不耐烦，不刷新台词（再唠叨反而更烦）
  if (state.mood === 'annoyed' && state.hold && now < state.hold.until) {
    return { state: { ...base, mood: 'annoyed', hold: { mood: 'annoyed', until: now + HOLD_MS.annoyed } } }
  }

  // 连点 → 不耐烦（优先级最高）
  if (clicks.length >= opts.annoyedClicks) {
    return {
      state: { ...base, mood: 'annoyed', hold: { mood: 'annoyed', until: now + HOLD_MS.annoyed }, clicks: [] },
      trigger: 'annoyed',
    }
  }

  // 早安：早间时段内、当天第一次交互
  if (isMorning(now, opts) && state.lastGreetDate !== dateKey(now)) {
    return {
      state: {
        ...base,
        mood: 'smile',
        hold: { mood: 'smile', until: now + HOLD_MS.smile },
        lastGreetDate: dateKey(now),
      },
      trigger: 'morning',
    }
  }

  return {
    state: { ...base, mood: 'smile', hold: { mood: 'smile', until: now + HOLD_MS.smile } },
    trigger: 'tap',
  }
}

/** 是否应该说话：被打扰 / 唤醒 / 打招呼都值得一句台词；tick 不主动出声（S1 不打搅） */
export function shouldSpeak(trigger: PetTrigger | undefined): trigger is PetTrigger {
  return !!trigger
}

/** 持久化只需要这几个字段，避免把 clicks 之类的临时数据写进磁盘 */
export function persistableState(state: PetState): Pick<PetState, 'lastInteractAt' | 'lastGreetDate'> {
  return { lastInteractAt: state.lastInteractAt, lastGreetDate: state.lastGreetDate }
}
