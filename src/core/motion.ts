// motion.ts - 动作契约（领域层，零平台依赖）
// 目的：把「角色怎么动」与「用什么引擎画」彻底分开。
//   - 状态机（petState / locomotion）只输出状态
//   - 皮肤皮肤（atlas / spine）只声明「我有哪些动作」
//   - 渲染适配器负责把 ClipName 变成一个正在播放的动画
// 换皮肤 = 换一份 manifest + 一套素材，不改任何代码。
//
// 视角（view）：最少两个。
//   front = 正面：待机、睡觉、舔爪、伸懒腰、被点、生气、眩晕、唤醒
//   side  = 纯侧影：走路、攀爬、倒挂、腾空、落地、被拿起
// 规则：
//   - 只有 side 允许左右镜像；front 永远不翻转
//   - 倒挂必须单独画一张，不能靠旋转 180°（会让脸倒过来，看起来像翻车）
//   - 跨视角切换要走 turn，不能硬切

import type { LocoState } from './locomotion'
import type { PetMood } from './petState'

export type SkinView = 'front' | 'side'

export type ClipName =
  | 'idle'
  | 'walk'
  | 'climb'
  | 'hang'
  | 'fall'
  | 'land'
  | 'held'
  | 'stretch'
  | 'groom'
  | 'tap'
  | 'annoyed'
  | 'dizzy'
  | 'sleep'
  | 'wake'
  | 'look'
  | 'pat'
  | 'grumble'
  | 'turn'

export interface ClipSpec {
  /** 这个动作属于哪个视角 */
  view: SkinView
  /** 帧数；1 表示静态帧 */
  frames: number
  fps: number
  loop: boolean
  /** 图集中的行号（atlas 用；spine 忽略） */
  row: number
  /** 可选：该帧序列的像素尺寸，缺省用 manifest.size */
  frameSize?: { w: number; h: number }
}

export interface SkinManifest {
  id: string
  name: string
  version: number
  engine: 'atlas' | 'spine'
  /** 角色整体尺寸（CSS 像素） */
  size: { w: number; h: number }
  /**
   * 锚点：决定「脚踩在哪里」。两个视角的锚点不同——
   * 正面锚在肚子下方中心，侧面锚在后爪。
   */
  anchors: Record<SkinView, { x: number; y: number }>
  clips: Partial<Record<ClipName, ClipSpec>>
  /** 动作缺失时的回退链，例如 climb → walk → idle */
  fallbacks?: Partial<Record<ClipName, ClipName>>
  /** 素材路径（相对 manifest 所在目录） */
  assets: { atlas?: string; skeleton?: string }
}

/** 必须实现的动作：缺了会退化，但不会崩（见 resolveClip） */
export const REQUIRED_CLIPS: ClipName[] = [
  'idle',
  'walk',
  'climb',
  'hang',
  'fall',
  'land',
  'held',
  'stretch',
  'groom',
  'tap',
  'annoyed',
  'dizzy',
  'sleep',
  'wake',
  'look',
  'pat',
  'grumble',
]

/** locomotion 状态 → 动作名 */
const LOCO_CLIP: Record<LocoState, ClipName> = {
  idle: 'idle',
  walk: 'walk',
  climb: 'climb',
  hang: 'hang',
  fall: 'fall',
  land: 'land',
  held: 'held',
}

/** 情绪 → 动作名（只在「没有在移动」时生效） */
const MOOD_CLIP: Partial<Record<PetMood, ClipName>> = {
  sleep: 'sleep',
  doze: 'sleep',
  dizzy: 'dizzy',
  annoyed: 'annoyed',
  curious: 'tap',
  smile: 'tap',
}

/**
 * 根据「身体状态 + 情绪 + 是否刚被唤醒」决定播哪个动作。
 * 优先级：移动状态 > 原地小动作 > 情绪 > 待机。
 */
export function clipForState(
  loco: LocoState,
  mood: PetMood,
  opts: {
    action?: 'stretch' | 'groom'
    justWoke?: boolean
    /** 刚被摸头 */
    justPatted?: boolean
    /** 刚被戳/挠，有点不满 */
    justGrumble?: boolean
    /** 鼠标在附近，它在看你 */
    looking?: boolean
  } = {},
): ClipName {
  if (loco !== 'idle') return LOCO_CLIP[loco]
  if (opts.justWoke) return 'wake'
  if (opts.justPatted) return 'pat'
  if (opts.justGrumble) return 'grumble'
  if (opts.action) return opts.action
  if (mood === 'annoyed') return 'annoyed'
  if (mood === 'dizzy') return 'dizzy'
  if (mood === 'sleep' || mood === 'doze') return 'sleep'
  if (opts.looking) return 'look'
  if (mood === 'smile') return 'tap'
  if (mood === 'curious') return 'tap'
  return 'idle'
}

/** 动作属于哪个视角 */
export function viewOf(clip: ClipName): SkinView {
  switch (clip) {
    case 'walk':
    case 'climb':
    case 'hang':
    case 'fall':
    case 'land':
    case 'held':
      return 'side'
    default:
      return 'front'
  }
}

/** 该动作是否允许镜像翻转（只有侧影允许） */
export function canMirror(clip: ClipName): boolean {
  return viewOf(clip) === 'side' && clip !== 'climb' && clip !== 'hang'
}

/**
 * 解析实际可播的片段：先找自己，再沿 fallbacks 链回退，最后退到 idle。
 * 返回 null 表示这份皮肤连 idle 都没有（不能用）。
 */
export function resolveClip(manifest: SkinManifest, clip: ClipName): ClipSpec | null {
  const seen = new Set<ClipName>()
  let cur: ClipName | undefined = clip
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const spec = manifest.clips[cur]
    if (spec && spec.frames > 0 && spec.fps > 0) return spec
    cur = manifest.fallbacks?.[cur]
  }
  return manifest.clips.idle ?? null
}

/** 校验清单：返回错误列表，空数组表示通过 */
export function validateManifest(m: unknown): string[] {
  const errors: string[] = []
  if (!m || typeof m !== 'object') return ['manifest 不是对象']
  const manifest = m as Partial<SkinManifest>

  if (!manifest.id) errors.push('缺少 id')
  if (!manifest.name) errors.push('缺少 name')
  if (manifest.engine !== 'atlas' && manifest.engine !== 'spine') errors.push('engine 必须是 atlas 或 spine')
  if (!manifest.size || manifest.size.w <= 0 || manifest.size.h <= 0) errors.push('size 不合法')
  if (!manifest.anchors?.front || !manifest.anchors?.side) errors.push('必须为 front 与 side 各声明一个锚点')

  if (!manifest.clips) {
    errors.push('缺少 clips')
    return errors
  }

  for (const [name, spec] of Object.entries(manifest.clips)) {
    if (!spec) continue
    if (spec.frames <= 0) errors.push(`${name}: frames 必须 > 0`)
    if (spec.fps <= 0) errors.push(`${name}: fps 必须 > 0`)
    if (spec.view !== 'front' && spec.view !== 'side') errors.push(`${name}: view 必须是 front 或 side`)
    if (spec.view !== viewOf(name as ClipName)) {
      errors.push(`${name}: 视角声明为 ${spec.view}，但契约要求 ${viewOf(name as ClipName)}`)
    }
  }

  if (!manifest.clips.idle) errors.push('必须实现 idle（所有动作的最终回退）')

  const missing = REQUIRED_CLIPS.filter((c) => !manifest.clips?.[c])
  if (missing.length) errors.push(`缺少动作（可用 fallbacks 补齐）：${missing.join(', ')}`)

  return errors
}

/** 需要为这份皮肤准备哪些素材：按视角分组，方便美术排期 */
export function clipsByView(m: SkinManifest): Record<SkinView, ClipName[]> {
  const out: Record<SkinView, ClipName[]> = { front: [], side: [] }
  for (const name of REQUIRED_CLIPS) {
    out[viewOf(name)].push(name)
  }
  return out
}
