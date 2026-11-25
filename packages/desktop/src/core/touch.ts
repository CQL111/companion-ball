// touch.ts - 触摸区域与注视方向（领域层，零平台依赖）
// 目的：让「点哪儿」有意义——摸头它会开心，戳身体/挠脚会不满，鼠标在附近时它会看过去。
// 只输出区域与方向，不涉及 DOM。

export type TouchZone = 'head' | 'body' | 'feet' | 'outside'

/** 角色在不同视角下的可见区域（0–1 归一化，坐标原点在角色框左上角） */
export interface ZoneBoxes {
  /** 头部矩形 */
  head: { top: number; bottom: number; left: number; right: number }
  /** 脚/下腹矩形 */
  feet: { top: number; bottom: number; left: number; right: number }
}

const FRONT_BOXES: ZoneBoxes = {
  head: { top: 0.04, bottom: 0.52, left: 0.12, right: 0.88 },
  feet: { top: 0.82, bottom: 1, left: 0.1, right: 0.9 },
}

const SIDE_BOXES: ZoneBoxes = {
  head: { top: 0.02, bottom: 0.45, left: 0.45, right: 1 },
  feet: { top: 0.78, bottom: 1, left: 0.05, right: 0.95 },
}

export function zonesFor(view: 'front' | 'side'): ZoneBoxes {
  return view === 'side' ? SIDE_BOXES : FRONT_BOXES
}

/**
 * 判断点落在哪个区域。
 * @param nx,ny 相对角色框的归一化坐标（0–1）
 */
export function zoneAt(view: 'front' | 'side', nx: number, ny: number): TouchZone {
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return 'outside'
  const z = zonesFor(view)
  const inBox = (b: { top: number; bottom: number; left: number; right: number }) =>
    ny >= b.top && ny <= b.bottom && nx >= b.left && nx <= b.right
  if (inBox(z.head)) return 'head'
  if (inBox(z.feet)) return 'feet'
  return 'body'
}

/** 不同区域的反应：决定播哪个动作与用哪组台词 */
export interface TouchReaction {
  action: 'pat' | 'grumble' | 'tap'
  /** 0–1，用于挑选语气更强的台词 */
  intensity: number
}

export function reactionFor(zone: TouchZone): TouchReaction {
  switch (zone) {
    case 'head':
      return { action: 'pat', intensity: 1 }
    case 'body':
      return { action: 'tap', intensity: 0.5 }
    case 'feet':
      return { action: 'grumble', intensity: 0.8 }
    default:
      return { action: 'tap', intensity: 0.3 }
  }
}

/**
 * 注视方向：把鼠标相对角色中心的位置换算成瞳孔偏移。
 * 返回 -1..1 的归一化方向，超过 maxRadius 时截断（眼睛不会「飞出去」）。
 */
export function gazeToward(
  centerX: number,
  centerY: number,
  pointerX: number,
  pointerY: number,
  maxRadius = 240,
): { x: number; y: number } {
  const dx = pointerX - centerX
  const dy = pointerY - centerY
  const dist = Math.hypot(dx, dy)
  if (dist < 1) return { x: 0, y: 0 }
  const k = Math.min(1, dist / maxRadius)
  return { x: (dx / dist) * k, y: (dy / dist) * k }
}

/** 鼠标足够近时才算「在注意我」 */
export function isPayingAttention(dist: number, threshold = 220): boolean {
  return dist <= threshold
}
