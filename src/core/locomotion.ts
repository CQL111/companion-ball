// locomotion.ts - 桌面上的身体：走动 / 爬墙 / 天花板悬挂 / 抛掷物理（领域层，零平台依赖）
// 与 petState 分工：
//   petState 管情绪（为什么动），locomotion 管身体（怎么动）。
//   状态机只输出位置与动作，不碰 DOM；渲染端只负责每帧应用。
//
// 设计约束（docs/ROADMAP.md 两条红线）：
// - 安静型：大多数时间待机，偶尔走动/攀爬；睡觉时不乱动
// - 被用户拿起时完全服从用户；放下后按速度飞出、落地

export const PET_SIZE = 80

export interface Bounds {
  width: number
  height: number
}

export type LocoState = 'idle' | 'walk' | 'climb' | 'hang' | 'fall' | 'land' | 'held'

export type LocoCue = 'land' | 'soft' | 'none'

export type Plan =
  | { kind: 'walk'; x: number; then?: 'climb-left' | 'climb-right' }
  | { kind: 'climb'; side: 'left' | 'right' }
  | { kind: 'hang'; dir: 1 | -1; until: number }

export interface Loco {
  state: LocoState
  x: number
  y: number
  /** px/s */
  vx: number
  vy: number
  facing: 1 | -1
  plan: Plan | null
  /** 空闲后何时做下一次自主决定 */
  nextDecisionAt: number
  /** land 状态结束时间 */
  landUntil: number
}

export interface StepInput {
  dtMs: number
  now: number
  bounds: Bounds
  /** 是否可以自主走动（睡觉、菜单打开、被按住时为 false） */
  canWander: boolean
  random?: () => number
}

export interface StepResult {
  loco: Loco
  cue: LocoCue
}

const GRAVITY = 2400 // px/s²
const WALK_SPEED = 46 // px/s，慢一点，别像虫子
const CLIMB_SPEED = 34 // px/s
const HANG_SPEED = 30 // px/s
const LAND_MS = 420
/** 安静型：两次自主决定之间的间隔 */
const IDLE_MIN_MS = 60_000
const IDLE_MAX_MS = 180_000
const HANG_MIN_MS = 6_000
const HANG_MAX_MS = 14_000
/** 落地冲击超过这个速度才出声，避免每帧都响 */
const LAND_CUE_SPEED = 420

export function initLoco(x: number, y: number, now = 0): Loco {
  return {
    state: 'idle',
    x,
    y,
    vx: 0,
    vy: 0,
    facing: 1,
    plan: null,
    nextDecisionAt: now + 20_000,
    landUntil: 0,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function floorY(bounds: Bounds): number {
  return Math.max(0, bounds.height - PET_SIZE)
}

function rightWallX(bounds: Bounds): number {
  return Math.max(0, bounds.width - PET_SIZE)
}

function pickIdleDelay(random: () => number): number {
  return IDLE_MIN_MS + random() * (IDLE_MAX_MS - IDLE_MIN_MS)
}

/** 用户按住：冻结所有自主运动，位置交给拖拽逻辑 */
export function grabLoco(l: Loco): Loco {
  return { ...l, state: 'held', vx: 0, vy: 0, plan: null }
}

/** 用户松手：按释放速度飞出（vx/vy 单位 px/s） */
export function releaseLoco(l: Loco, vx: number, vy: number, now: number): Loco {
  // vx 会在 stepLoco 的墙边反弹里被衰减，若不夹紧，连续撞墙会让水平速度越来越大
  const clampV = (v: number): number => Math.max(-1500, Math.min(1500, v))
  return { ...l, state: 'fall', vx: clampV(vx), vy: clampV(vy), plan: null, landUntil: 0, nextDecisionAt: now }
}

/** 拖拽过程中同步内部坐标，避免松手时从旧位置开始 */
export function syncLocoPosition(l: Loco, x: number, y: number): Loco {
  return { ...l, x, y }
}

/**
 * 推进一帧。dt 会被截断到 50ms，避免切后台回来时瞬移。
 * 返回新对象，不修改入参。
 */
export function stepLoco(l: Loco, input: StepInput): StepResult {
  const random = input.random ?? Math.random
  const dt = Math.max(0, Math.min(input.dtMs, 50)) / 1000
  const maxX = rightWallX(input.bounds)
  const fy = floorY(input.bounds)

  // 用户按住：什么都不做
  if (l.state === 'held') return { loco: l, cue: 'none' }

  if (l.state === 'fall') {
    let { x, y, vx, vy } = l
    vy += GRAVITY * dt
    x += vx * dt
    y += vy * dt
    let cue: LocoCue = 'none'

    // 左右墙反弹（损耗一半速度）
    if (x < 0) {
      x = 0
      vx = Math.abs(vx) * 0.5
    } else if (x > maxX) {
      x = maxX
      vx = -Math.abs(vx) * 0.5
    }
    // 撞天花板
    if (y < 0) {
      y = 0
      vy = Math.abs(vy) * 0.4
    }
    // 落地
    if (y >= fy) {
      y = fy
      const impact = vy
      vy = 0
      vx = 0
      cue = impact > LAND_CUE_SPEED ? 'land' : 'none'
      return {
        loco: { ...l, x, y, vx, vy, state: 'land', landUntil: input.now + LAND_MS, plan: null },
        cue,
      }
    }
    return { loco: { ...l, x, y, vx, vy }, cue }
  }

  if (l.state === 'land') {
    if (input.now >= l.landUntil) {
      return {
        loco: { ...l, state: 'idle', plan: null, nextDecisionAt: input.now + pickIdleDelay(random) },
        cue: 'none',
      }
    }
    return { loco: l, cue: 'none' }
  }

  if (l.state === 'walk') {
    const plan = l.plan
    const targetX = plan && plan.kind === 'walk' ? plan.x : l.x
    const dir = Math.sign(targetX - l.x) || l.facing
    const step = WALK_SPEED * dt * dir
    let x = l.x + step
    const reached = Math.abs(targetX - x) < WALK_SPEED * dt || Math.abs(targetX - l.x) < 2
    const facing: 1 | -1 = dir >= 0 ? 1 : -1
    if (reached) {
      x = targetX
      // 到达墙边且计划是攀爬 → 开始往上爬
      if (plan && plan.kind === 'walk' && plan.then) {
        const side = plan.then === 'climb-left' ? 'left' : 'right'
        return {
          loco: { ...l, x, facing, state: 'climb', plan: { kind: 'climb', side } },
          cue: 'none',
        }
      }
      return { loco: { ...l, x, facing, state: 'idle', plan: null, nextDecisionAt: input.now + pickIdleDelay(random) }, cue: 'none' }
    }
    return { loco: { ...l, x: clamp(x, 0, maxX), facing }, cue: 'none' }
  }

  if (l.state === 'climb') {
    const y = l.y - CLIMB_SPEED * dt
    if (y <= 0) {
      // 爬到天花板 → 倒挂，沿天花板走一段
      const dir: 1 | -1 = random() < 0.5 ? 1 : -1
      const until = input.now + HANG_MIN_MS + random() * (HANG_MAX_MS - HANG_MIN_MS)
      return { loco: { ...l, y: 0, state: 'hang', facing: dir, plan: { kind: 'hang', dir, until } }, cue: 'soft' }
    }
    const x = l.plan && l.plan.kind === 'climb' && l.plan.side === 'right' ? maxX : 0
    return { loco: { ...l, x, y, facing: l.facing }, cue: 'none' }
  }

  if (l.state === 'hang') {
    const plan = l.plan && l.plan.kind === 'hang' ? l.plan : { kind: 'hang' as const, dir: l.facing, until: input.now + 8000 }
    let dir = plan.dir
    let x = l.x + HANG_SPEED * dt * dir
    if (x <= 0) {
      x = 0
      dir = 1
    } else if (x >= maxX) {
      x = maxX
      dir = -1
    }
    // 到时间去地面
    if (input.now >= plan.until) {
      return { loco: { ...l, x, state: 'fall', vx: dir * 40, vy: 0, plan: null }, cue: 'none' }
    }
    return { loco: { ...l, x, facing: dir, plan: { kind: 'hang', dir, until: plan.until } }, cue: 'none' }
  }

  // idle
  if (!input.canWander) {
    return { loco: { ...l, state: 'idle', plan: null, nextDecisionAt: input.now + 2000 }, cue: 'none' }
  }
  if (input.now < l.nextDecisionAt) return { loco: l, cue: 'none' }

  const r = random()
  if (r < 0.5) {
    // 在屏幕上走一段
    const target = Math.round(random() * maxX)
    return {
      loco: { ...l, state: 'walk', plan: { kind: 'walk', x: target }, facing: target >= l.x ? 1 : -1 },
      cue: 'none',
    }
  }
  if (r < 0.72) {
    // 走到最近的墙，然后往上爬
    const side = l.x < maxX / 2 ? 'climb-left' : 'climb-right'
    const target = side === 'climb-left' ? 0 : maxX
    return {
      loco: { ...l, state: 'walk', plan: { kind: 'walk', x: target, then: side }, facing: target >= l.x ? 1 : -1 },
      cue: 'none',
    }
  }
  // 什么都不做：继续待着
  return { loco: { ...l, nextDecisionAt: input.now + pickIdleDelay(random) }, cue: 'none' }
}

/** 仅用于测试与调试：把角色直接放到某个表面 */
export function placeOnFloor(l: Loco, x: number, bounds: Bounds): Loco {
  return { ...l, state: 'idle', plan: null, x: clamp(x, 0, rightWallX(bounds)), y: floorY(bounds), vx: 0, vy: 0 }
}
