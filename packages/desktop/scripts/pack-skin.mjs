// scripts/pack-skin.mjs - 把单帧 PNG 拼成图集 + manifest
// 用法：
//   npm run pack:skin -- <帧目录> [--id my-cat] [--name "我的猫"] [--size 48] [--out <目录>]
// 帧命名：
//   idle-0.png idle-1.png ... walk-0.png ...
//   目录里可放 meta.json 覆盖 fps / size / id / name
// 产物：
//   <out>/cat.png + <out>/manifest.json（默认输出到 src/renderer/pet/skins/<id>/）
//
// 为什么需要它：AI 生图只能给单帧，网格排版、尺寸对齐、清单生成交给脚本，
// 保证 manifest 与实际图集永远一致（手写 manifest 是换肤后动作错乱的头号原因）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 与 src/core/motion.ts 保持一致
const CLIPS = [
  ['front', 'idle', 4, 6, true],
  ['front', 'tap', 2, 8, false],
  ['front', 'sleep', 2, 2, true],
  ['front', 'wake', 4, 10, false],
  ['front', 'stretch', 6, 6, false],
  ['front', 'groom', 6, 8, false],
  ['front', 'annoyed', 4, 8, true],
  ['front', 'dizzy', 4, 10, true],
  ['side', 'walk', 6, 10, true],
  ['side', 'climb', 6, 8, true],
  ['side', 'hang', 4, 6, true],
  ['side', 'fall', 2, 6, true],
  ['side', 'land', 4, 10, false],
  ['side', 'held', 2, 4, true],
]

function parseArgs(argv) {
  const args = { dir: null, id: null, name: null, size: null, out: null }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1]
      if (['id', 'name', 'size', 'out'].includes(key)) {
        args[key] = val
        i++
      }
    } else {
      rest.push(a)
    }
  }
  args.dir = rest[0] || null
  return args
}

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))
if (!args.dir) {
  console.error('用法: npm run pack:skin -- <帧目录> [--id my-cat] [--name "我的猫"] [--size 48] [--out <目录>]')
  process.exit(1)
}

const framesDir = path.resolve(ROOT, args.dir)
if (!fs.existsSync(framesDir)) fail(`帧目录不存在: ${args.dir}`)

const metaPath = path.join(framesDir, 'meta.json')
const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {}

const id = args.id || meta.id || path.basename(framesDir)
const name = args.name || meta.name || id
const size = Number(args.size || meta.size || 48)
const outDir = args.out ? path.resolve(ROOT, args.out) : path.join(ROOT, 'src', 'renderer', 'pet', 'skins', id)

// ---------- 收集帧 ----------
const files = fs.readdirSync(framesDir).filter((f) => /\.png$/i.test(f))
const byClip = new Map()
for (const f of files) {
  const m = /^([a-z]+)[-_](\d+)\.png$/i.exec(f)
  if (!m) {
    console.warn(`⚠️  跳过无法识别的文件: ${f}（命名应为 <动作>-<序号>.png）`)
    continue
  }
  const [, clip, idx] = m
  if (!byClip.has(clip)) byClip.set(clip, [])
  byClip.get(clip).push({ idx: Number(idx), file: f })
}
for (const list of byClip.values()) list.sort((a, b) => a.idx - b.idx)

// ---------- 校验 ----------
const errors = []
const unknown = [...byClip.keys()].filter((c) => !CLIPS.some(([, n]) => n === c))
if (unknown.length) errors.push(`未知动作名：${unknown.join(', ')}（允许：${CLIPS.map((c) => c[1]).join(', ')}）`)

const missing = CLIPS.filter(([, n]) => !byClip.has(n)).map(([, n]) => n)
// idle 是最终回退，必须有；其他缺失会记警告
if (missing.includes('idle')) errors.push('缺少 idle（所有动作的最终回退，必须有）')

const columns = Math.max(...[...byClip.values()].map((l) => l.length), 1)
const warnings = []

if (errors.length) {
  errors.forEach((e) => console.error(`❌ ${e}`))
  process.exit(1)
}

// ---------- 排版 ----------
const firstFrame = await loadImage(path.join(framesDir, byClip.get('idle')[0].file))
const fw = firstFrame.width
const fh = firstFrame.height
for (const [clip, list] of byClip) {
  for (const item of list) {
    const img = await loadImage(path.join(framesDir, item.file))
    if (img.width !== fw || img.height !== fh) {
      errors.push(`${clip}-${item.idx}.png 尺寸 ${img.width}x${img.height}，与 idle 的 ${fw}x${fh} 不一致`)
    }
  }
}
if (errors.length) {
  errors.forEach((e) => console.error(`❌ ${e}`))
  process.exit(1)
}

const sheet = createCanvas(fw * columns, fh * CLIPS.length)
const ctx = sheet.getContext('2d')

// canvas 的 drawImage 不接受路径，必须传已解码的图片对象
const decoded = new Map()
for (const [clip, list] of byClip) {
  for (const item of list) {
    decoded.set(clip + ':' + item.idx, await loadImage(path.join(framesDir, item.file)))
  }
}

const clips = {}
CLIPS.forEach(([view, clipName, defFrames, defFps, defLoop], row) => {
  const list = byClip.get(clipName) || []
  const fps = Number(meta.fps?.[clipName] || defFps)
  const loop = meta.loop?.[clipName] ?? defLoop
  if (!list.length) {
    warnings.push(`${clipName} 缺失 → 将在清单里用 fallbacks 指向相近动作`)
    return
  }
  list.forEach((item, col) => {
    if (col >= columns) return
    const img = decoded.get(clipName + ':' + item.idx)
    if (img) ctx.drawImage(img, col * fw, row * fh, fw, fh)
  })
  clips[clipName] = { view, frames: Math.min(list.length, columns), fps, loop, row }
})

// 缺失动作的回退建议（与占位皮肤保持一致的策略）
const FALLBACKS = {
  wake: 'tap',
  groom: 'idle',
  stretch: 'idle',
  annoyed: 'tap',
  dizzy: 'idle',
  climb: 'walk',
  hang: 'climb',
  fall: 'walk',
  land: 'idle',
  held: 'fall',
}
const fallbacks = {}
for (const clip of missing) {
  if (clip === 'idle') continue
  const target = FALLBACKS[clip] || 'idle'
  fallbacks[clip] = clips[target] ? target : 'idle'
}

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'cat.png'), sheet.toBuffer('image/png'))

const manifest = {
  id,
  name,
  version: 1,
  engine: 'atlas',
  size: { w: size, h: size },
  anchors: {
    front: { x: size / 2, y: size * 0.92 },
    side: { x: size / 2, y: size * 0.92 },
  },
  clips,
  ...(Object.keys(fallbacks).length ? { fallbacks } : {}),
  assets: { atlas: 'cat.png', columns },
  frameSize: { w: fw, h: fh },
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

// ---------- 报告 ----------
console.log(`✅ 已生成皮肤 ${id} → ${path.relative(ROOT, outDir)}`)
console.log(`   图集 ${columns}×${CLIPS.length} 帧，单帧 ${fw}×${fh}，显示尺寸 ${size}px`)
console.log(`   已包含动作 ${Object.keys(clips).length}/${CLIPS.length}：${Object.keys(clips).join(', ')}`)
if (warnings.length) {
  console.warn('\n⚠️  需要注意：')
  warnings.forEach((w) => console.warn(`   - ${w}`))
}
if (missing.length && missing.includes('idle')) fail('缺少 idle，无法使用')
