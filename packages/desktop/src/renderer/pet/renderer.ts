// renderer.ts - 精灵图集渲染适配器（Canvas 2D）
// 职责：只做一件事——把「动作名 + 朝向 + 锚点」画到 canvas 上。
// 不感知情绪、物理、台词；那些都在 core/ 里。
//
// 为什么先用 Canvas 2D 而不是 PixiJS：
// 同屏只有一个角色、几十个精灵，性能从来不是瓶颈；drawImage 足够，
// 还能省掉 300–450KB。以后要特效或 Spine，只需换掉这个文件——
// 对外接口（setClip / setFacing / render / destroy）保持不变。

import type { ClipName, SkinManifest, SkinView } from '../../core/motion'

interface LoadedSkin {
  manifest: SkinManifest
  image: CanvasImageSource
  frameSize: { w: number; h: number }
  columns: number
}

export interface SpriteRenderer {
  /** 切换动作；同一动作重复调用不会重播 */
  setClip(clip: ClipName): void
  /** 朝向：true = 朝右（素材默认朝右），false = 镜像朝左。正面视角忽略 */
  setFacing(right: boolean): void
  /** 注视方向（-1..1），只影响瞳孔与轻微微移；没有 look 动作时退化为整体偏移 */
  setGaze(dir: { x: number; y: number }): void
  /** 当前动作与视角（调试用） */
  current(): { clip: ClipName; view: SkinView }
  /** 每帧调用 */
  render(dtMs: number): void
  destroy(): void
}

export interface SkinSource {
  manifest: SkinManifest
  /** 图集地址（由打包器给出：dev 是 http 地址，打包后是 file:// 相对路径） */
  atlasUrl: string
  columns?: number
  frameSize?: { w: number; h: number }
}

/**
 * 加载皮肤。素材地址由调用方通过 Vite 的 `?url` 导入后传入——
 * 不要在这里 fetch manifest：打包后页面是 file://，fetch 会被拦截。
 */
export async function loadSkin(canvas: HTMLCanvasElement, source: SkinSource): Promise<SpriteRenderer> {
  const { manifest } = source
  const image = await loadImage(source.atlasUrl)

  const frameSize = source.frameSize ?? {
    w: manifest.size.w,
    h: manifest.size.h,
  }

  const skin: LoadedSkin = {
    manifest,
    image,
    frameSize,
    columns: source.columns ?? 8,
  }
  return createRenderer(canvas, skin)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`素材加载失败: ${src}`))
    img.src = src
  })
}

function createRenderer(canvas: HTMLCanvasElement, skin: LoadedSkin): SpriteRenderer {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas 2d context 不可用')
  const ctx: CanvasRenderingContext2D = context

  const { manifest, image, frameSize, columns } = skin
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
  // 显示尺寸 = manifest.size；画布按 DPR 放大，保证清晰
  const displayW = manifest.size.w
  const displayH = manifest.size.h
  canvas.width = Math.round(displayW * dpr)
  canvas.height = Math.round(displayH * dpr)

  let clip: ClipName = 'idle'
  let facingRight = true
  let gaze: { x: number; y: number } = { x: 0, y: 0 }
  let frame = 0
  let elapsed = 0

  function specOf(c: ClipName) {
    // 先找自己，再沿 fallbacks 回退，最后 idle
    const seen = new Set<ClipName>()
    let cur: ClipName | undefined = c
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const s = manifest.clips[cur]
      if (s && s.frames > 0 && s.fps > 0) return { clip: cur, spec: s }
      cur = manifest.fallbacks?.[cur]
    }
    const idle = manifest.clips.idle
    return idle ? { clip: 'idle' as ClipName, spec: idle } : null
  }

  function viewOfClip(c: ClipName): SkinView {
    const found = manifest.clips[c]?.view
    if (found) return found
    return specOf(c)?.spec.view || 'front'
  }

  function render(dtMs: number): void {
    const resolved = specOf(clip)
    if (!resolved) return
    const { clip: actual, spec } = resolved

    // 推进帧
    elapsed += dtMs
    const frameMs = 1000 / spec.fps
    if (elapsed >= frameMs) {
      const advance = Math.floor(elapsed / frameMs)
      elapsed -= advance * frameMs
      frame = spec.loop ? (frame + advance) % spec.frames : Math.min(frame + advance, spec.frames - 1)
    }

    const view = spec.view

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, displayW, displayH)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    const sx = frame * frameSize.w
    const sy = spec.row * frameSize.h

    // 侧影朝左时整体镜像（以画布中线为轴），正面永不翻转
    const mirror = view === 'side' && !facingRight
    ctx.save()
    if (mirror) {
      ctx.translate(displayW, 0)
      ctx.scale(-1, 1)
    }
    // 注视：整体轻微偏移（角色本身有 look 动作时，这里是叠加的微动）
    const gx = gaze.x * displayW * 0.025
    const gy = gaze.y * displayH * 0.02
    ctx.drawImage(image, sx, sy, frameSize.w, frameSize.h, gx, gy, displayW, displayH)
    ctx.restore()

    // 调试信息挂到 canvas 数据集，e2e 与截图可以直接读
    canvas.dataset.clip = actual
    canvas.dataset.view = view
    canvas.dataset.frame = String(frame)
    canvas.dataset.facing = view === 'side' ? (facingRight ? 'right' : 'left') : 'front'
  }

  return {
    setClip(next: ClipName) {
      if (next === clip) return
      clip = next
      frame = 0
      elapsed = 0
    },
    setFacing(right: boolean) {
      facingRight = right
    },
    setGaze(dir: { x: number; y: number }) {
      gaze = dir
    },
    current() {
      const resolved = specOf(clip)
      const view = resolved ? resolved.spec.view : 'front'
      return { clip: resolved ? resolved.clip : 'idle', view }
    },
    render,
    destroy() {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    },
  }
}
