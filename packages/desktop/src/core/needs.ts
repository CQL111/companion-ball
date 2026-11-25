// needs.ts - 「它需要你」（领域层，零平台依赖）
//
// 设计约束（这是产品判断，不是技术选择）：
// 1. **可拒绝，不惩罚**：拒绝只会让它安静一会儿，不会累积「好感下降」。
//    有惩罚就变成养成负担，而我们的用户是「孤独但不想社交」的人。
// 2. **每天主动提需求的次数有上限**：默认 2 次。打扰预算是硬红线。
// 3. **深夜不提需求**：0–6 点只允许「想被摸」且不說話，其他一律沉默。
// 4. 需求不是数值游戏：不显示进度条、不显示数字、不会因为没满足而死掉。

export type NeedKind = 'hungry' | 'bored' | 'lonely'

export interface NeedsState {
  /** 上次被满足/拒绝的时间，用于衰减 */
  lastActedAt: number
  /** 当日主动提需求的次数 */
  todayCount: number
  /** 计数所属日期（YYYY-MM-DD） */
  day: string
  /** 当前正在表达的请求（null = 没有） */
  active: NeedKind | null
  /** 这个请求什么时候过期（过了就自己放弃，不再提） */
  activeUntil: number
  /** 用户最近一次拒绝的时间（用于「安静一会儿」） */
  lastDeclinedAt: number
}

export const NEEDS_DAILY_MAX = 2
/** 一次请求最多挂多久；过期自动放弃，不纠缠 */
export const NEED_EXPIRES_MS = 10 * 60 * 1000
/** 被拒绝后安静多久 */
export const DECLINE_QUIET_MS = 90 * 60 * 1000
/** 两次请求之间至少间隔 */
export const NEED_GAP_MS = 90 * 60 * 1000

export function initNeeds(now: number, day: string): NeedsState {
  return { lastActedAt: now, todayCount: 0, day, active: null, activeUntil: 0, lastDeclinedAt: 0 }
}

function localDay(now: number): string {
  const d = new Date(now)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${dd}`
}

/** 深夜不打扰：0–6 点 */
export function isQuietHour(now: number): boolean {
  const h = new Date(now).getHours()
  return h < 6
}

/**
 * 是否该冒出一次需求。
 * 纯判断，不改状态。返回 null 表示现在不该说话。
 */
export function nextNeed(state: NeedsState, now: number, opts: { dailyMax?: number; gapMs?: number } = {}): NeedKind | null {
  const dailyMax = opts.dailyMax ?? NEEDS_DAILY_MAX
  const gapMs = opts.gapMs ?? NEED_GAP_MS

  // 已有请求还没过期：不重复提
  if (state.active && now < state.activeUntil) return null
  if (isQuietHour(now)) return null
  if (state.day !== localDay(now)) {
    // 跨天：只重置计数，是否提由调用方下一轮判断
    return null
  }
  if (state.todayCount >= dailyMax) return null
  if (state.lastDeclinedAt && now - state.lastDeclinedAt < DECLINE_QUIET_MS) return null
  if (now - state.lastActedAt < gapMs) return null

  // 三种需求轮流来，避免总用同一种口气
  const cycle: NeedKind[] = ['hungry', 'bored', 'lonely']
  return cycle[state.todayCount % cycle.length] ?? 'lonely'
}

export type NeedEvent =
  | { type: 'raise'; now: number; kind: NeedKind }
  | { type: 'satisfy'; now: number }
  | { type: 'decline'; now: number }
  | { type: 'expire'; now: number }
  | { type: 'tick'; now: number }

/** 推进需求状态。返回新对象，不修改入参。 */
export function reduceNeeds(state: NeedsState, event: NeedEvent): NeedsState {
  const today = localDay(event.now)
  const base: NeedsState = state.day === today ? state : { ...state, day: today, todayCount: 0 }

  switch (event.type) {
    case 'raise':
      // 同一天第 N 次提出；计数 +1
      return {
        ...base,
        active: event.kind,
        activeUntil: event.now + NEED_EXPIRES_MS,
        todayCount: base.todayCount + 1,
        lastActedAt: event.now,
      }
    case 'satisfy':
      return { ...base, active: null, activeUntil: 0, lastActedAt: event.now }
    case 'decline':
      // 关键：拒绝只让它安静，**不扣任何东西**
      return { ...base, active: null, activeUntil: 0, lastDeclinedAt: event.now, lastActedAt: event.now }
    case 'expire':
      // 过期视为自己放弃，同样不惩罚；但也不给「下次机会」补偿
      return { ...base, active: null, activeUntil: 0, lastActedAt: event.now }
    case 'tick':
      if (base.active && event.now >= base.activeUntil) {
        return { ...base, active: null, activeUntil: 0 }
      }
      return base
  }
}

/** 每种需求的台词：有诉求，但不乞求 */
export const NEED_LINES: Record<NeedKind, string[]> = {
  hungry: ['我有点饿了。', '饭点到了吗。', '我想吃点东西。', '肚子在叫。'],
  bored: ['有点无聊。', '陪我玩一下？', '我在这儿转圈呢。', '你忙你的，我看看你。'],
  lonely: ['你在吗。', '想你了。', '刚才有点安静。', '我等你很久了。'],
}

/** 用户满足需求时的回应（简短、不夸张） */
export const NEED_SATISFIED_LINES: Record<NeedKind, string[]> = {
  hungry: ['吃饱了。', '谢谢。', '这下有力气了。'],
  bored: ['好多了。', '谢谢你陪我。', '开心。'],
  lonely: ['嗯，我在。', '有你就不闷了。', '这样就好。'],
}

export function pickNeedLine(kind: NeedKind, random: () => number = Math.random): string {
  const pool = NEED_LINES[kind]
  return pool[Math.floor(random() * pool.length)] ?? pool[0]!
}

export function pickSatisfiedLine(kind: NeedKind, random: () => number = Math.random): string {
  const pool = NEED_SATISFIED_LINES[kind]
  return pool[Math.floor(random() * pool.length)] ?? pool[0]!
}
