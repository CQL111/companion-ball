// needMotion.ts - 把「它需要你」翻译成身体动作（领域层，零平台依赖）
//
// P0.5 的核心：需求不再只靠一声气泡，而是先**被看见**。
//   饿了   → 走到屏幕边缘，贴着边抬头（像盯着你的手边）
//   无聊   → 扒在边缘 / 自己转圈（seek 到别处再张望）
//   想你   → 走到鼠标附近停下，抬头看你
//
// 三条约束（与 core/needs.ts 的判断一致）：
//   1. 不新增渲染路径：只产出 Plan，交给现有 locomotion 执行
//   2. 不新增台词：说话仍由 speech.ts 统一决定（身体可以先于语言出现）
//   3. 可被打断：睡觉 / 菜单打开 / 被拖动时一律不表达

import type { Plan } from './locomotion'
import type { NeedKind } from './needs'

/** 身体表达的最小上下文：只依赖「现在能用什么」 */
export interface BodyContext {
  boundsWidth: number
  maxX: number
  x: number
  /** 鼠标停留位置（窗口坐标）；没有则不做「想你」表达 */
  interestPoint: { x: number; y: number } | null
}

export interface NeedMotion {
  plan: Plan
  /** 这次身体表达持续多久（毫秒），到点回到普通待机 */
  until: number
}

/** 屏幕最右可站位置：与 locomotion 的 rightWallX 同一口径（留一个身位） */
function rightWallX(ctx: BodyContext): number {
  return Math.max(0, ctx.maxX)
}

const EDGE_MARGIN = 8
/** 一次身体表达最多持续多久：太久会像卡住了 */
export const NEED_MOTION_MS = 12_000

/**
 * 需求 → 动作计划。
 * 返回 null 表示这个需求现在不该用身体表达（例如没有鼠标位置时的 lonely），
 * 调用方应退回「只用台词」的旧行为，而不是硬造一个动作。
 */
export function planForNeed(kind: NeedKind, ctx: BodyContext, now: number): NeedMotion | null {
  const maxX = rightWallX(ctx)
  const x = ctx.x

  switch (kind) {
    case 'hungry': {
      // 走到最近的边缘，贴着边抬头——像在等你分一口
      const target = x < maxX / 2 ? EDGE_MARGIN : maxX - EDGE_MARGIN
      if (Math.abs(target - x) < 4) {
        // 已经在边上：直接原地张望（用 seek 到同一点会产生抖动）
        return { plan: { kind: 'stretch' }, until: now + NEED_MOTION_MS }
      }
      return { plan: { kind: 'seek', x: target }, until: now + NEED_MOTION_MS }
    }

    case 'bored': {
      // 无聊：走到屏幕中间附近停下来（不是乱跑，是「没事做」）。
      // 用位置算出目标，保证同一位置每次结果一致，不引入随机。
      const third = Math.floor(maxX / 3)
      const target = x < maxX / 2 ? Math.min(maxX, x + third) : Math.max(0, x - third)
      const clamped = Math.max(EDGE_MARGIN, Math.min(maxX - EDGE_MARGIN, target))
      if (Math.abs(clamped - x) < 20) {
        return { plan: { kind: 'groom' }, until: now + NEED_MOTION_MS }
      }
      return { plan: { kind: 'seek', x: clamped }, until: now + NEED_MOTION_MS }
    }

    case 'lonely': {
      // 想你：走到鼠标附近停下（没有鼠标信息就不表达，避免瞎走）
      const ip = ctx.interestPoint
      if (!ip) return null
      const target = Math.max(EDGE_MARGIN, Math.min(maxX - EDGE_MARGIN, Math.round(ip.x)))
      if (Math.abs(target - x) < 24) {
        // 已经在旁边了：抬头看
        return { plan: { kind: 'stretch' }, until: now + NEED_MOTION_MS }
      }
      return { plan: { kind: 'seek', x: target }, until: now + NEED_MOTION_MS }
    }
  }
}

/**
 * 当前是否允许用身体表达需求。
 * 睡觉 / 打盹 / 被按住 / 菜单打开时一律不允许——和在 needs.ts 里的打扰预算是同一套判断。
 */
export function canExpressNeed(opts: {
  mood: string
  canWander: boolean
  now: number
  activeUntil: number
}): boolean {
  if (!opts.canWander) return false
  if (opts.mood === 'sleep' || opts.mood === 'doze') return false
  // 需求已过期：不再继续演
  return opts.now < opts.activeUntil
}
