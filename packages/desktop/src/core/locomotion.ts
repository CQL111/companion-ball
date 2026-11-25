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

export type LocoState =
  | 'idle'
  | 'walk'
  | 'climb'
  | 'hang'
  | 'fall'
  | 'land'
  | 'held'
  /** 被拖到屏幕边缘松手：扒住边缘不往下掉 */
  | 'perch'
  /** 自己走到屏幕左右边缘抬头看（不是攀爬） */
  | 'edgePeek'
  /** 困了自己走到角落趴下 */
  | 'snooze'

export type LocoCue = 'land' | 'soft' | 'none'

export type Plan =
  | { kind: 'walk'; x: number; then?: 'climb-left' | 'climb-right' }
  | { kind: 'climb'; side: 'left' | 'right' }
  | { kind: 'hang'; dir: 1 | -1; until: number }
  /** 原地小动作：伸懒腰 / 舔爪 */
  | { kind: 'stretch' }
  | { kind: 'groom' }
  /** 朝某个目标位置走去（比如鼠标停下的地方） */
  | { kind: 'seek'; x: number }
  /** 扒在左/右边缘 */
  | { kind: 'perch'; side: 'left' | 'right'; until: number }
  /** 走到角落趴下（困了） */
  | { kind: 'snooze'; x: number }

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
  /** 下次允许「走过去看看鼠标」的时间（防止一直追着跑） */
  nextSeekAt: number
}

export interface StepInput {
  dtMs: number
  now: number
  bounds: Bounds
  /** 是否可以自主走动（睡觉、菜单打开、被按住时为 false） */
  canWander: boolean
  random?: () => number
  /**
   * 鼠标停留的位置（窗口坐标）。有值时角色可能走过去看看；
   * null/undefined 表示没有兴趣点（鼠标在动或已离开）。
   */
  interestPoint?: { x: number; y: number } | null
  /** 困了：自己走到最近的角落趴下（不能自主活动时也允许慢走） */
  sleepy?: boolean
}

export interface StepResult {
  loco: Loco
  cue: LocoCue
}

const GRAVITY = 2400 // px/s²
const WALK_SPEED = 60 // px/s，与 0.42s 步频配合，看起来像在迈步
const CLIMB_SPEED = 38 // px/s
const HANG_SPEED = 30 // px/s
const LAND_MS = 420
/** 安静型：两次自主决定之间的间隔（要求「几分钟内能看见动作」） */
const IDLE_MIN_MS = 25_000
const IDLE_MAX_MS = 70_000
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
    nextSeekAt: 0,
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

/** 距离边缘多近算「扒在边上」（像素） */
export const PERCH_SNAP = 18
/** 扒住的最长时间，之后会松手掉下去 */
const PERCH_MS = 14_000

/** 用户松手：按释放速度飞出（vx/vy 单位 px/s）
 *  传入 bounds 时：**刚被拖动过**、贴着左右边缘、且速度很慢 → 扒住边缘而不是掉下去。
 *  @param wasDragged 是否真的拖动过（只点一下不算）
 */
export function releaseLoco(
  l: Loco,
  vx: number,
  vy: number,
  now: number,
  bounds?: Bounds,
  wasDragged = true,
): Loco {
  // vx 会在 stepLoco 的墙边反弹里被衰减，若不夹紧，连续撞墙会让水平速度越来越大
  const clampV = (v: number): number => Math.max(-1500, Math.min(1500, v))
  const slow = Math.hypot(vx, vy) < 260

  if (bounds && slow && wasDragged) {
    const maxX = Math.max(0, bounds.width - PET_SIZE)
    if (l.x <= PERCH_SNAP) {
      return {
        ...l,
        x: 0,
        state: 'perch',
        vx: 0,
        vy: 0,
        facing: 1,
        plan: { kind: 'perch', side: 'left', until: now + PERCH_MS },
        nextDecisionAt: now,
      }
    }
    if (maxX - l.x <= PERCH_SNAP) {
      return {
        ...l,
        x: maxX,
        state: 'perch',
        vx: 0,
        vy: 0,
        facing: -1,
        plan: { kind: 'perch', side: 'right', until: now + PERCH_MS },
        nextDecisionAt: now,
      }
    }
  }
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

  // 不能自主走动时（睡着 / 菜单打开 / 拖动中），正在走的这一段要立刻停下 ——
  // 否则会看到「睡着了还在走」这种穿帮。物理状态（fall/land/hang）不受影响。
  if (!input.canWander && l.state === 'walk') {
    return {
      loco: { ...l, state: 'idle', plan: null, vx: 0, vy: 0, nextDecisionAt: input.now + 60_000 },
      cue: 'none',
    }
  }

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
    const targetX = plan && (plan.kind === 'walk' || plan.kind === 'seek' || plan.kind === 'snooze') ? plan.x : l.x
    const dir = Math.sign(targetX - l.x) || l.facing
    const step = WALK_SPEED * dt * dir
    let x = l.x + step
    const reached = Math.abs(targetX - x) < WALK_SPEED * dt || Math.abs(targetX - l.x) < 2
    const facing: 1 | -1 = dir >= 0 ? 1 : -1
    if (reached) {
      x = targetX
      // 到达墙边且计划是攀爬 → 开始往上爬
      if (plan && plan.kind === 'snooze') {
        return { loco: { ...l, x, facing, state: 'snooze', plan }, cue: 'none' }
      }
      if (plan && plan.kind === 'seek') {
        // 走到鼠标附近：停一会儿，抬头看
        return {
          loco: { ...l, x, facing, state: 'idle', plan: null, nextDecisionAt: input.now + 8000 },
          cue: 'none',
        }
      }
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

  if (l.state === 'perch') {
    const plan = l.plan && l.plan.kind === 'perch' ? l.plan : { kind: 'perch' as const, side: 'left' as const, until: input.now + 3000 }
    if (input.now >= plan.until) {
      // 扒不住了，松手掉下去
      return { loco: { ...l, state: 'fall', vx: plan.side === 'left' ? 40 : -40, vy: 0, plan: null }, cue: 'none' }
    }
    // 扒着时轻轻晃（不改位置，交给渲染端做姿态）
    return { loco: { ...l, facing: plan.side === 'left' ? 1 : -1 }, cue: 'none' }
  }

  if (l.state === 'edgePeek') {
    // 在边缘张望一会儿就回去
    if (input.now >= l.nextDecisionAt) {
      return { loco: { ...l, state: 'idle', plan: null, nextDecisionAt: input.now + pickIdleDelay(random) }, cue: 'none' }
    }
    return { loco: l, cue: 'none' }
  }

  // 困了：走到最近的角落趴下（即使 canWander=false 也允许，这是「自己要睡」）
  if (input.sleepy && l.state === 'idle') {
    const edge = l.x < maxX / 2 ? 0 : maxX
    if (Math.abs(edge - l.x) > 12) {
      return {
        loco: { ...l, state: 'walk', plan: { kind: 'snooze', x: edge }, facing: edge >= l.x ? 1 : -1 },
        cue: 'none',
      }
    }
    return { loco: { ...l, state: 'snooze', plan: { kind: 'snooze', x: edge } }, cue: 'none' }
  }
  if (l.state === 'snooze' && !input.sleepy) {
    // 醒了：回到普通待机
    return { loco: { ...l, state: 'idle', plan: null, nextDecisionAt: input.now + pickIdleDelay(random) }, cue: 'none' }
  }
  if (l.state === 'snooze') return { loco: l, cue: 'none' }

  // idle
  if (!input.canWander) {
    return { loco: { ...l, state: 'idle', plan: null, nextDecisionAt: input.now + 2000 }, cue: 'none' }
  }
  // 鼠标停留：走过去看看（有冷却，避免一直追着跑）
  const ip = input.interestPoint
  if (ip && input.now >= l.nextSeekAt) {
    const target = Math.round(Math.max(0, Math.min(maxX, ip.x)))
    const far = Math.abs(target - l.x) > 40
    // 太近就别去（避免原地抖），但也要把冷却推后，否则每帧都会重新判断
    l = far ? l : { ...l, nextSeekAt: input.now + 30_000 }
    if (far) {
      return {
        loco: {
          ...l,
          state: 'walk',
          plan: { kind: 'seek', x: target },
          facing: target >= l.x ? 1 : -1,
          nextSeekAt: input.now + 3 * 60 * 1000,
        },
        cue: 'none',
      }
    }
  }

  if (input.now < l.nextDecisionAt) return { loco: l, cue: 'none' }

  const r = random()
  if (r < 0.45) {
    // 在屏幕上走一段
    const target = Math.round(random() * maxX)
    return {
      loco: { ...l, state: 'walk', plan: { kind: 'walk', x: target }, facing: target >= l.x ? 1 : -1 },
      cue: 'none',
    }
  }
  if (r < 0.75) {
    // 走到最近的墙，然后往上爬
    const side = l.x < maxX / 2 ? 'climb-left' : 'climb-right'
    const target = side === 'climb-left' ? 0 : maxX
    return {
      loco: { ...l, state: 'walk', plan: { kind: 'walk', x: target, then: side }, facing: target >= l.x ? 1 : -1 },
      cue: 'none',
    }
  }
  if (r < 0.83) {
    // 走到某侧边缘张望一会儿
    const side = random() < 0.5 ? 'left' : 'right'
    const target = side === 'left' ? 0 : maxX
    return {
      loco: {
        ...l,
        state: 'walk',
        plan: { kind: 'seek', x: target },
        facing: target >= l.x ? 1 : -1,
        // 到达后转为 edgePeek：复用 seek 的到达逻辑，但下一步用 nextDecisionAt 控制
        nextDecisionAt: input.now + 6000,
      },
      cue: 'none',
    }
  }
  if (r < 0.90) {
    // 伸懒腰：原地，约 3 秒
    return {
      loco: { ...l, state: 'idle', plan: { kind: 'stretch' }, nextDecisionAt: input.now + 3000 },
      cue: 'none',
    }
  }
  if (r < 0.95) {
    // 舔爪：原地，约 2.5 秒
    return {
      loco: { ...l, state: 'idle', plan: { kind: 'groom' }, nextDecisionAt: input.now + 2500 },
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
