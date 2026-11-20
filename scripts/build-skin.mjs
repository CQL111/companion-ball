// scripts/build-skin.mjs - 程序化生成占位皮肤（两视角 × 14 动作）
// 目的：用一套真实的图集跑通「动作契约 → 图集 → 渲染」全链路，随时可替换成美术资源。
// 用法：node scripts/build-skin.mjs
// 产物：
//   src/renderer/pet/skins/placeholder/cat.png      图集
//   src/renderer/pet/skins/placeholder/manifest.json
//
// 设计约束（对应 docs/ARCHITECTURE.md 与 src/core/motion.ts）：
//   - 正面视角永远不镜像；侧影允许镜像（由渲染层做，素材本身朝右）
//   - 倒挂单独画，不用旋转 180°
//   - 锚点：脚掌着地位置，两视角分别声明

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'pet', 'skins', 'placeholder')

// 超采样：在 3 倍尺寸下绘制，渲染时再缩回 displaySize，避免糊
const SS = 3
const W = 48 * SS
const H = 48 * SS
const DISPLAY = 48
const PALETTE = {
  fur: '#f6cfd9',
  furDark: '#e2a8b8',
  furLight: '#fffafc',
  ink: '#3a2b3d',
  nose: '#e8728f',
  blush: '#ff9db4',
}

// ---------- 图集布局 ----------
// 正面：idle / tap / sleep / wake / stretch / groom / annoyed / dizzy  → 8 行
// 侧影：walk / climb / hang / fall / land / held                       → 6 行
const FRAMES_PER_ROW = 8
const ROWS = [
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

const sheet = createCanvas(W * FRAMES_PER_ROW, H * ROWS.length)
const sctx = sheet.getContext('2d')
// 每个姿势都按 SS 缩放的坐标绘制
// 当前帧的缩放系数（由渲染循环设置，绘制函数内所有坐标都乘它）
let S = SS

// ---------- 基础形状 ----------
function ellipse(ctx, x, y, rx, ry, fill) {
  ctx.beginPath()
  ctx.ellipse(x * S, y * S, rx * S, ry * S, 0, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
}

function line(ctx, x1, y1, x2, y2, color, width) {
  ctx.beginPath()
  ctx.moveTo(x1 * S, y1 * S)
  ctx.lineTo(x2 * S, y2 * S)
  ctx.strokeStyle = color
  ctx.lineWidth = width * S
  ctx.lineCap = 'round'
  ctx.stroke()
}

function heart(ctx, x, y, s, color) {
  ctx.save()
  ctx.translate(x * S, y * S)
  ctx.scale(s * S, s * S)
  ctx.beginPath()
  ctx.moveTo(0, 3)
  ctx.bezierCurveTo(-4, -1, -2, -4, 0, -2)
  ctx.bezierCurveTo(2, -4, 4, -1, 0, 3)
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

function zzz(ctx, x, y, size, color) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.4 * S
  ctx.lineCap = 'round'
  const X = x * S
  const Y = y * S
  const Z = size * S
  ctx.beginPath()
  ctx.moveTo(X, Y)
  ctx.lineTo(X + Z, Y)
  ctx.lineTo(X, Y + Z)
  ctx.lineTo(X + Z, Y + Z)
  ctx.stroke()
  ctx.restore()
}

// ---------- 正面姿态 ----------
function drawFront(ctx, ox, oy, p) {
  const cx = ox + 24
  const ground = oy + 43
  const bob = p.bob ?? 0
  const squash = p.squash ?? 1
  const lean = p.lean ?? 0

  ctx.save()
  ctx.translate(cx * S, (ground - 40 + bob) * S)
  ctx.rotate((lean * Math.PI) / 180)
  ctx.scale(1, squash)

  // 尾巴
  ctx.save()
  ctx.translate(10 * S, (27 + (p.bodyLift ?? 0)) * S)
  ctx.rotate(((p.tail ?? 0) * Math.PI) / 180)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.bezierCurveTo(10 * S, 2 * S, 14 * S, -6 * S, 9 * S, -12 * S)
  ctx.strokeStyle = PALETTE.furDark
  ctx.lineWidth = 4.4 * S
  ctx.lineCap = 'round'
  ctx.stroke()
  ctx.restore()

  // 后腿 / 前腿
  const legSwing = p.legSwing ?? 0
  line(ctx, -7, 26, -8 + legSwing, 39, PALETTE.fur, 5)
  line(ctx, 7, 26, 8 - legSwing, 39, PALETTE.fur, 5)
  ellipse(ctx, -8 + legSwing, 39.5, 3.4, 1.9, PALETTE.furLight)
  ellipse(ctx, 8 - legSwing, 39.5, 3.4, 1.9, PALETTE.furLight)

  // 身体
  ellipse(ctx, 0, 24, 15.5, 16, PALETTE.fur)
  ellipse(ctx, 0, 28, 8.5, 8.5, PALETTE.furLight)

  // 耳朵
  const earRot = p.ear ?? 0
  for (const side of [-1, 1]) {
    ctx.save()
    ctx.translate(side * 8 * S, 9 * S)
    ctx.rotate(((side * earRot) * Math.PI) / 180)
    ctx.beginPath()
    ctx.moveTo(-5 * S, 4 * S)
    ctx.lineTo(0, -8 * S)
    ctx.lineTo(5 * S, 4 * S)
    ctx.closePath()
    ctx.fillStyle = PALETTE.fur
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(-2.4 * S, 2.5 * S)
    ctx.lineTo(0, -4 * S)
    ctx.lineTo(2.4 * S, 2.5 * S)
    ctx.closePath()
    ctx.fillStyle = '#f7a8bc'
    ctx.fill()
    ctx.restore()
  }

  // 呆毛
  ctx.beginPath()
  ctx.moveTo(0, 1 * S)
  ctx.quadraticCurveTo(2.5 * S, -3 * S, 0.5 * S, -6 * S)
  ctx.strokeStyle = PALETTE.furDark
  ctx.lineWidth = 1.3 * S
  ctx.stroke()

  // 头
  ellipse(ctx, 0, 12, 12.5, 11.5, PALETTE.fur)
  ellipse(ctx, 0, 16.5, 6, 4.4, PALETTE.furLight)

  // 眼睛
  const eyeMode = p.eyes ?? 'open'
  const pupilShift = p.pupilX ?? 0
  if (eyeMode === 'open') {
    ellipse(ctx, -4.5, 11, 2.6, 3, PALETTE.ink)
    ellipse(ctx, 4.5, 11, 2.6, 3, PALETTE.ink)
    ellipse(ctx, -4.5 + pupilShift * 0.3, 10.2, 1.1, 1.2, '#ffffff')
    ellipse(ctx, 4.5 + pupilShift * 0.3, 10.2, 1.1, 1.2, '#ffffff')
  } else if (eyeMode === 'shut') {
    ctx.strokeStyle = PALETTE.ink
    ctx.lineWidth = 1.5 * S
    for (const x of [-4.5, 4.5]) {
      ctx.beginPath()
      ctx.arc(x * S, 11 * S, 2.6 * S, Math.PI * 1.15, Math.PI * 1.85)
      ctx.stroke()
    }
  } else {
    ctx.strokeStyle = PALETTE.ink
    ctx.lineWidth = 1.5 * S
    for (const x of [-4.5, 4.5]) {
      ctx.beginPath()
      ctx.moveTo((x - 2.4) * S, 12 * S)
      ctx.quadraticCurveTo(x * S, 9 * S, (x + 2.4) * S, 12 * S)
      ctx.stroke()
    }
  }

  // 鼻子与嘴
  ctx.beginPath()
  ctx.moveTo(-1.2 * S, 15 * S)
  ctx.lineTo(1.2 * S, 15 * S)
  ctx.lineTo(0, 16.4 * S)
  ctx.closePath()
  ctx.fillStyle = PALETTE.nose
  ctx.fill()
  if (p.mouth === 'open') {
    ellipse(ctx, 0, 18.4, 1.8, 1.6, PALETTE.ink)
  } else {
    ctx.strokeStyle = PALETTE.ink
    ctx.lineWidth = 0.9 * S
    ctx.beginPath()
    ctx.moveTo(-2.2 * S, 17.4 * S)
    ctx.quadraticCurveTo(-1.1 * S, 18.6 * S, 0, 17.4 * S)
    ctx.quadraticCurveTo(1.1 * S, 18.6 * S, 2.2 * S, 17.4 * S)
    ctx.stroke()
  }

  // 腮红与胡须
  ellipse(ctx, -8, 15, 2.6, 1.4, p.blush ? 'rgba(255,140,170,0.75)' : 'rgba(255,140,170,0.35)')
  ellipse(ctx, 8, 15, 2.6, 1.4, p.blush ? 'rgba(255,140,170,0.75)' : 'rgba(255,140,170,0.35)')
  for (const side of [-1, 1]) {
    line(ctx, side * 5.5, 16, side * 12, 14.6, 'rgba(58,43,61,0.28)', 0.6)
    line(ctx, side * 5.5, 17.4, side * 12, 18, 'rgba(58,43,61,0.28)', 0.6)
  }

  ctx.restore()

  // 特效（不跟随姿态变换）
  if (p.zzz) {
    zzz(ctx, 38, 6, 4, 'rgba(120,110,160,0.75)')
    if (p.zzz > 1) zzz(ctx, 40, 2, 3, 'rgba(120,110,160,0.55)')
  }
  if (p.heart) heart(ctx, 39, 5, 1.5, 'rgba(255,120,160,0.9)')
  if (p.stars) {
    for (let i = 0; i < 3; i++) {
      ellipse(ctx, 8 + i * 13, 3 + (i % 2) * 3, 1.4, 1.4, 'rgba(252,211,77,0.9)')
    }
  }
}

// ---------- 侧面姿态（朝右） ----------
function drawSide(ctx, ox, oy, p) {
  const ground = oy + 43
  const bob = p.bob ?? 0
  const lean = p.lean ?? 0
  const crouch = p.crouch ?? 0

  ctx.save()
  ctx.translate((ox + 24) * S, (ground - 34 + bob + crouch) * S)
  ctx.rotate((lean * Math.PI) / 180)

  // 尾巴（在身后）
  ctx.save()
  ctx.translate(-11 * S, 8 * S)
  ctx.rotate(((p.tail ?? 0) * Math.PI) / 180)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.bezierCurveTo(-8 * S, -2 * S, -10 * S, -11 * S, -4 * S, -14 * S)
  ctx.strokeStyle = PALETTE.furDark
  ctx.lineWidth = 4 * S
  ctx.lineCap = 'round'
  ctx.stroke()
  ctx.restore()

  // 后腿 / 前腿
  const l1 = p.legA ?? 0
  const l2 = p.legB ?? 0
  line(ctx, -6, 18, -6 + l1, 32, PALETTE.fur, 5.4)
  line(ctx, 7, 18, 7 + l2, 32, PALETTE.fur, 5.4)
  ellipse(ctx, -6 + l1, 32.6, 3.6, 1.8, PALETTE.furLight)
  ellipse(ctx, 7 + l2, 32.6, 3.6, 1.8, PALETTE.furLight)

  // 身体（侧影：更长）
  ctx.beginPath()
  ctx.ellipse(0, 14 * S, 14 * S, 11 * S, -0.06, 0, Math.PI * 2)
  ctx.fillStyle = PALETTE.fur
  ctx.fill()
  ellipse(ctx, 2, 18, 7, 5.5, PALETTE.furLight)

  // 头（偏前）
  const headTilt = p.headTilt ?? 0
  ctx.save()
  ctx.translate(10 * S, 4 * S)
  ctx.rotate((headTilt * Math.PI) / 180)
  ellipse(ctx, 0, 0, 9.5, 8.8, PALETTE.fur)

  // 耳朵（侧影只看见一只）
  ctx.beginPath()
  ctx.moveTo(-3 * S, -7 * S)
  ctx.lineTo(1 * S, -14 * S)
  ctx.lineTo(6 * S, -6 * S)
  ctx.closePath()
  ctx.fillStyle = PALETTE.fur
  ctx.fill()

  // 口鼻与鼻子（朝右）
  ellipse(ctx, 5, 3, 4.4, 3.4, PALETTE.furLight)
  ctx.beginPath()
  ctx.moveTo(9 * S, 2.2 * S)
  ctx.lineTo(7.6 * S, 3.6 * S)
  ctx.lineTo(9 * S, 4.4 * S)
  ctx.closePath()
  ctx.fillStyle = PALETTE.nose
  ctx.fill()

  // 眼睛
  if (p.eyes === 'shut') {
    ctx.strokeStyle = PALETTE.ink
    ctx.lineWidth = 1.2 * S
    ctx.beginPath()
    ctx.arc(2.5 * S, -0.5 * S, 1.8 * S, Math.PI * 1.1, Math.PI * 1.9)
    ctx.stroke()
  } else {
    ellipse(ctx, 2.5, -0.5, 1.9, 2.3, PALETTE.ink)
    ellipse(ctx, 3.1, -1.2, 0.8, 0.9, '#ffffff')
  }

  // 胡须
  line(ctx, 8.5, 3.4, 14, 2.2, 'rgba(58,43,61,0.28)', 0.6)
  line(ctx, 8.5, 4.4, 14, 5.2, 'rgba(58,43,61,0.28)', 0.6)

  ctx.restore()
  ctx.restore()
}

// ---------- 倒挂（单独绘制，不做旋转） ----------
function drawHang(ctx, wave) {
  ctx.save()
  ctx.translate(24 * S, 2 * S)

  // 顶部抓握
  for (const dx of [-6, 6]) {
    line(ctx, dx, 0, dx, 7, PALETTE.fur, 5)
    ellipse(ctx, dx, 1, 3.2, 1.8, PALETTE.furLight)
  }

  // 后腿垂下
  line(ctx, -5, 22, -6, 30, PALETTE.fur, 5)
  line(ctx, 5, 22, 6, 30, PALETTE.fur, 5)
  ellipse(ctx, -6, 30.5, 3.2, 1.7, PALETTE.furLight)
  ellipse(ctx, 6, 30.5, 3.2, 1.7, PALETTE.furLight)

  ctx.save()
  ctx.translate(wave * 1.2 * S, 0)
  ellipse(ctx, 0, 14, 10.5, 11, PALETTE.fur)
  ellipse(ctx, 0, 17, 5.5, 6.5, PALETTE.furLight)

  // 尾巴垂下
  ctx.save()
  ctx.translate(9 * S, 16 * S)
  ctx.rotate(((20 + wave * 6) * Math.PI) / 180)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.bezierCurveTo(7 * S, 5 * S, 9 * S, 13 * S, 3 * S, 18 * S)
  ctx.strokeStyle = PALETTE.furDark
  ctx.lineWidth = 3.8 * S
  ctx.lineCap = 'round'
  ctx.stroke()
  ctx.restore()

  // 头在下方
  ellipse(ctx, 1, 30, 9.5, 8.5, PALETTE.fur)
  for (const side of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo((1 + side * 6) * S, 35 * S)
    ctx.lineTo((1 + side * 9) * S, 42 * S)
    ctx.lineTo((1 + side * 2) * S, 37 * S)
    ctx.closePath()
    ctx.fillStyle = PALETTE.fur
    ctx.fill()
  }
  ellipse(ctx, -2.6, 28.5, 2.2, 2.6, PALETTE.ink)
  ellipse(ctx, 4.4, 28.5, 2.2, 2.6, PALETTE.ink)
  ellipse(ctx, -2.2, 28, 0.9, 1, '#ffffff')
  ellipse(ctx, 4.8, 28, 0.9, 1, '#ffffff')
  ctx.beginPath()
  ctx.moveTo(0.2 * S, 32 * S)
  ctx.lineTo(2 * S, 32 * S)
  ctx.lineTo(1.1 * S, 33.2 * S)
  ctx.closePath()
  ctx.fillStyle = PALETTE.nose
  ctx.fill()
  ellipse(ctx, -6, 31.5, 2.2, 1.2, 'rgba(255,140,170,0.4)')
  ellipse(ctx, 7.5, 31.5, 2.2, 1.2, 'rgba(255,140,170,0.4)')
  ctx.restore()

  ctx.restore()
}

// ---------- 逐帧渲染 ----------
const clipRows = {}

ROWS.forEach(([view, name, frames, fps, loop], row) => {
  clipRows[name] = { row, frames, fps, loop, view }
  for (let f = 0; f < frames; f++) {
    const ox = f * W
    const oy = row * H
    const t = frames > 1 ? f / frames : 0
    const wave = Math.sin(t * Math.PI * 2)

    const ctx = sctx
    ctx.save()
    ctx.translate(ox, oy)
    // 绘制函数内部会自己乘 S，这里只设置系数
    S = SS
    ctx.clearRect(0, 0, W, H)

    if (view === 'front') {
      switch (name) {
        case 'idle':
          drawFront(ctx, 0, 0, { bob: wave * 0.6, tail: wave * 6 })
          break
        case 'tap':
          drawFront(ctx, 0, 0, { bob: -1.5, eyes: f === 0 ? 'happy' : 'open', blush: true, heart: true, tail: 14 })
          break
        case 'sleep':
          drawFront(ctx, 0, 0, { bob: 1.5, squash: 0.95, eyes: 'shut', ear: 26, zzz: f === 0 ? 1 : 2, tail: -12 })
          break
        case 'wake':
          drawFront(ctx, 0, 0, {
            bob: f < 2 ? 1 : -0.5,
            squash: f < 2 ? 0.95 : 1.02,
            eyes: f < 2 ? 'shut' : 'open',
            ear: f < 2 ? 20 : -6,
            tail: wave * 10,
          })
          break
        case 'stretch':
          drawFront(ctx, 0, 0, {
            bob: f <= 2 ? 2 : -2,
            squash: f <= 2 ? 0.9 : 1.06,
            lean: f <= 2 ? 0 : -8,
            eyes: f <= 2 ? 'shut' : 'happy',
            legSwing: f <= 2 ? 0 : 3,
            tail: 20,
          })
          break
        case 'groom':
          drawFront(ctx, 0, 0, {
            lean: f >= 2 && f <= 4 ? 5 : 0,
            eyes: f >= 2 && f <= 4 ? 'shut' : 'open',
            legSwing: f >= 2 && f <= 4 ? -4 : 0,
            ear: f >= 2 && f <= 4 ? 12 : 0,
            tail: wave * 8,
          })
          break
        case 'annoyed':
          drawFront(ctx, 0, 0, {
            lean: -4,
            ear: -34,
            eyes: 'open',
            pupilX: wave * 1.5,
            tail: wave * 22,
            mouth: 'open',
            bob: wave * 0.8,
          })
          break
        case 'dizzy':
          drawFront(ctx, 0, 0, {
            lean: wave * 6,
            eyes: 'shut',
            stars: true,
            tail: wave * 14,
            bob: f % 2 === 0 ? -0.8 : 0.8,
          })
          break
      }
    } else {
      switch (name) {
        case 'walk':
          drawSide(ctx, 0, 0, {
            legA: wave * 6,
            legB: -wave * 6,
            bob: Math.abs(wave) * -1.2,
            tail: wave * 10,
            headTilt: wave * 2,
          })
          break
        case 'climb':
          drawSide(ctx, 0, 0, {
            lean: -16,
            legA: f % 2 === 0 ? -8 : 2,
            legB: f % 2 === 0 ? 2 : -8,
            bob: f % 2 === 0 ? -0.6 : 0.6,
            tail: 18,
            headTilt: -10,
          })
          break
        case 'hang':
          // 倒挂：单独画。整帧翻转会把阴影翻到头顶、头也倒过来，看着像翻车。
          // 正确画法是：爪子勾在上方，身体垂直向下垂，头在下方朝前。
          drawHang(ctx, wave)
          break
        case 'fall':
          drawSide(ctx, 0, 0, {
            lean: -8 + wave * 3,
            legA: -10,
            legB: 10,
            tail: 28,
            headTilt: 6,
          })
          break
        case 'land':
          drawSide(ctx, 0, 0, {
            crouch: f < 2 ? 4 : 1,
            legA: f < 2 ? 8 : 3,
            legB: f < 2 ? -8 : -3,
            eyes: f < 2 ? 'shut' : 'open',
            tail: -10,
          })
          break
        case 'held':
          drawSide(ctx, 0, 0, {
            lean: 6,
            legA: 5,
            legB: -5,
            tail: -18,
            bob: wave * 1.2,
          })
          break
      }
    }
    ctx.restore()
  }
})

// ---------- 输出 ----------
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'cat.png'), sheet.toBuffer('image/png'))

const manifest = {
  id: 'placeholder-cat',
  name: '占位团子猫',
  version: 1,
  engine: 'atlas',
  size: { w: DISPLAY, h: DISPLAY },
  frameSize: { w: W, h: H },
  anchors: {
    front: { x: 24, y: 44 },
    side: { x: 24, y: 44 },
  },
  clips: Object.fromEntries(
    Object.entries(clipRows).map(([name, r]) => [
      name,
      {
        view: r.view,
        frames: r.frames,
        fps: r.fps,
        loop: r.loop,
        row: r.row,
      },
    ]),
  ),
  fallbacks: { wake: 'tap', turn: 'idle' },
  assets: { atlas: 'cat.png', columns: FRAMES_PER_ROW },
}

fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(
  `✅ 已生成占位皮肤：${path.relative(ROOT, OUT_DIR)}（${FRAMES_PER_ROW}×${ROWS.length} 帧，${Object.keys(clipRows).length} 个动作）`,
)
