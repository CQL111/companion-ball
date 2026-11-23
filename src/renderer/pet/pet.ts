// pet.ts - 团子猫渲染器（命令式，不经 React）
// 设计要点：
// - 窗口全屏透明，body 走 pointer-events:none 让点击穿透到桌面
// - 球本身 pointer-events:auto，只有它能点击
// - 球的位置完全由 CSS transform 控制，零 IPC 即可丝滑拖拽
// - 仅在拖拽结束时 IPC 落盘位置；菜单打开时上报「猫 + 面板」热区

import '../renderer-logger'
import {
  initPetState,
  reducePetState,
  persistableState,
  dateKey,
  type PetEvent,
  type PetState,
} from '../../core/petState'
import { pickBucket, pickQuip, rememberQuip, type QuipBucket, type QuipDatabase, type QuipHistory } from '../../core/quips'
import quipDbRaw from '../../data/quips.json'
import { grabLoco, initLoco, releaseLoco, stepLoco, syncLocoPosition, type Bounds, type Loco } from '../../core/locomotion'
import { playSound, setSoundEnabled } from './sound'
import { gazeToward, isPayingAttention, reactionFor, zoneAt } from '../../core/touch'
import { clipForState, type ClipName } from '../../core/motion'
import { loadSkin, type SpriteRenderer } from './renderer'
// ?url 让 Vite 负责拷贝素材并给出正确地址（dev 与打包后都可用）
import atlasUrl from './skins/placeholder/cat.png?url'
import skinManifest from './skins/placeholder/manifest.json'

const ball = document.getElementById('ball') as HTMLDivElement
const ballInner = document.getElementById('ball-inner') as HTMLDivElement
const canvas = document.getElementById('pet-canvas') as HTMLCanvasElement
const bubble = document.getElementById('pet-bubble') as HTMLDivElement | null
const petMenu = document.getElementById('pet-menu') as HTMLElement | null

const BALL_SIZE = 80

// 交互锁：预览动画期间不响应点击
let isDrawing = false

// ---------- 情绪状态机（S1） ----------
// 状态机在 core/，这里只负责把平台事件翻译进去、把输出渲染出来。
const quipDb = quipDbRaw as unknown as QuipDatabase
let petState: PetState = initPetState(Date.now())
let quipHistory: QuipHistory = {}
let bubbleTimer = 0
let animationsEnabled = true
let lastPersistedAt = 0

// ---------- 角色渲染（精灵图集） ----------
let renderer: SpriteRenderer | null = null
let currentClip: ClipName | null = null
let justWokeUntil = 0
let patUntil = 0
let grumbleUntil = 0
let pointer: { x: number; y: number } | null = null
let looking = false
let gaze = { x: 0, y: 0 }
/** 鼠标停留超过 1.5 秒的位置；用来让猫走过去看看 */
let interestPoint: { x: number; y: number } | null = null
let lastPointerAt = 0
let lastPointerPos: { x: number; y: number } | null = null

/** 把「身体状态 + 情绪 + 原地动作」映射成动作名，交给渲染器 */
function paintClip(): void {
  if (!renderer) return
  const plan = loco.plan
  const action = plan && (plan.kind === 'stretch' || plan.kind === 'groom') ? plan.kind : undefined
  const now = Date.now()
  const clip = clipForState(loco.state, petState.mood, {
    action,
    justWoke: now < justWokeUntil,
    justPatted: now < patUntil,
    justGrumble: now < grumbleUntil,
    looking,
  })
  if (clip !== currentClip) {
    currentClip = clip
    renderer.setClip(clip)
  }
  renderer.setFacing(loco.facing > 0)
  ball.setAttribute('data-clip', clip)
}

function paintMood(): void {
  ballInner.setAttribute('data-mood', petState.mood)
  ball.setAttribute('data-mood', petState.mood)
  paintClip()
}

function showBubble(text: string | null): void {
  if (!bubble || !text) return
  bubble.textContent = text
  bubble.classList.add('show')
  // 先显示再量尺寸；贴边时把气泡平移回可视区，小三角反向补偿
  requestAnimationFrame(() => {
    bubble.style.setProperty('--bubble-shift', '0px')
    const r = bubble.getBoundingClientRect()
    const margin = 8
    let shift = 0
    if (r.left < margin) shift = margin - r.left
    else if (r.right > window.innerWidth - margin) shift = window.innerWidth - margin - r.right
    bubble.style.setProperty('--bubble-shift', `${Math.round(shift)}px`)
  })
  clearTimeout(bubbleTimer)
  // 不打搅：气泡 3 秒自灭，不抢焦点
  bubbleTimer = window.setTimeout(() => bubble.classList.remove('show'), 3000)
}

function speak(bucket: QuipBucket, now: number): void {
  const line = pickQuip(quipDb, bucket, quipHistory, now)
  if (!line) return
  quipHistory = rememberQuip(quipHistory, line, now)
  showBubble(line)
}

function persistPetState(): void {
  // 节流：状态机每秒都会 tick，只有状态变化时才走到这里
  const now = Date.now()
  if (now - lastPersistedAt < 5000) return
  lastPersistedAt = now
  const p = persistableState(petState)
  void window.api.getConfig('pet').then((cur) => {
    const next = { name: cur?.name || '', ...p }
    if (cur && cur.lastInteractAt === next.lastInteractAt && cur.lastGreetDate === next.lastGreetDate) return
    return window.api.saveConfig('pet', next)
  })
}

function dispatch(event: PetEvent): void {
  const beforeMood = petState.mood
  const r = reducePetState(petState, event)
  const moodChanged = r.state.mood !== beforeMood
  petState = r.state

  if (moodChanged) paintMood()
  if (r.trigger === 'wake') justWokeUntil = Date.now() + 900
  if (r.trigger) speak(pickBucket(r.trigger, event.now, petState.dragging), event.now)
  if (moodChanged || r.trigger) persistPetState()
  // S2：交互计数供日记使用（点击 / 拖动 / 唤醒才算，不是每秒 tick）
  if (event.type !== 'tick' && event.type !== 'pointer-leave') void window.api.bumpInteraction()
}

function tick(): void {
  dispatch({ type: 'tick', now: Date.now() })
}
window.setInterval(tick, 1000)

// ---------- 位置 ----------
let posX = 0
let posY = 0

let posSyncPending = false
function syncPosToMain(): void {
  if (posSyncPending) return
  posSyncPending = true
  requestAnimationFrame(() => {
    posSyncPending = false
    void window.api.updateBallPos(posX, posY)
  })
}

function setBallTransform(x: number, y: number): void {
  posX = x
  posY = y
  ball.style.transform = `translate(${x}px, ${y}px)`
  syncPosToMain()
}

// ---------- 桌面上的身体（v0.5.0） ----------
// locomotion 是纯函数：这里每帧推进、应用位置，并把姿态写成 data-loco 让 CSS 播放动画。
let loco: Loco = initLoco(0, 0)
let lastFrameAt = 0
let bounds: Bounds = { width: window.innerWidth, height: window.innerHeight }

function applyLoco(next: Loco): void {
  loco = next
  setBallTransform(Math.round(next.x), Math.round(next.y))
  ball.setAttribute('data-loco', next.state)
  // 原地小动作（伸懒腰 / 舔爪）用 data-act 单独驱动一次性动画
  const act = next.plan && (next.plan.kind === 'stretch' || next.plan.kind === 'groom') ? next.plan.kind : ''
  if (ball.getAttribute('data-act') !== act) ball.setAttribute('data-act', act)
  // 朝向：用 scaleX 翻转猫身，不能动 .ball 的 transform（位置由 setBallTransform 写）
  ballInner.style.setProperty('--face', String(next.facing))
}

function locoFrame(now: number): void {
  const dtMs = lastFrameAt ? now - lastFrameAt : 16
  lastFrameAt = now
  if (!dragState) {
    const r = stepLoco(loco, {
      dtMs,
      now: Date.now(),
      bounds,
      // 睡觉 / 菜单打开 / 预览动画时不自主活动
      canWander: petState.mood !== 'sleep' && petState.mood !== 'doze' && !ball.classList.contains('orbit-open') && !isDrawing,
      // 鼠标停着不动时，它可能会走过去看看
      interestPoint,
      // 困了（sleep/doze）会自己走到角落趴下
      sleepy: petState.mood === 'sleep' || petState.mood === 'doze',
    })
    applyLoco(r.loco)
    if (r.cue === 'land') playSound('land')
    if (r.cue === 'soft') playSound('soft')
  }
  paintClip()
  renderer?.render(dtMs)
  requestAnimationFrame(locoFrame)
}
requestAnimationFrame(locoFrame)

// ---------- 注视：主进程每 80ms 推一次光标位置 ----------
window.api.onCursorMoved((pos) => {
  pointer = pos
  // 鼠标停留判定：位置几乎没动且超过 1.5 秒 → 它可能会走过去看看
  const nowMs = Date.now()
  const moved = !lastPointerPos || Math.hypot(pos.x - lastPointerPos.x, pos.y - lastPointerPos.y) > 6
  if (moved) {
    lastPointerPos = pos
    lastPointerAt = nowMs
    interestPoint = null
  } else if (nowMs - lastPointerAt > 1500 && petState.mood !== 'sleep' && petState.mood !== 'doze') {
    interestPoint = pos
  }
  const cx = posX + BALL_SIZE / 2
  const cy = posY + BALL_SIZE * 0.4
  const dist = Math.hypot(pos.x - cx, pos.y - cy)
  looking = isPayingAttention(dist) && petState.mood !== 'sleep' && petState.mood !== 'doze'
  gaze = gazeToward(cx, cy, pos.x, pos.y)
  // 瞳孔偏移交给渲染器（缩放后的画布内坐标）
  renderer?.setGaze?.(gaze)
})

// ---------- S4：你走了 / 回来了 / 久坐 ----------
window.api.onPresenceAway(() => {
  // 你离开了：它自己待着，先不打扰
  window.logger.info('presence', 'user away')
})

window.api.onPresenceBack(({ awayMs }) => {
  window.logger.info('presence', `user back after ${Math.round(awayMs / 60000)}min`)
  dispatch({ type: 'returned', now: Date.now(), awayMs })
  // 离开很久：先闷一下，再说一句；短时间离开：抬头看你
  if (awayMs >= 2 * 60 * 60 * 1000) grumbleUntil = Date.now() + 2000
  else patUntil = Date.now() + 1200
})

window.api.onPresenceSit(({ text }) => {
  // 久坐提醒：用它自己的语气，不抢焦点，3 秒自灭
  showBubble(text)
  window.logger.info('presence.sit', 'reminded')
})

// ---------- S4：天气氛围（下雨 / 下雪 / 打雷时才说话） ----------
window.api.onWeatherChanged(({ kind, text }) => {
  window.logger.info('weather', `kind=${kind}`)
  // 纯氛围：说一句就够，不播报数据
  showBubble(text)
  ball.setAttribute('data-weather', kind)
})

window.addEventListener('resize', () => {
  bounds = { width: window.innerWidth, height: window.innerHeight }
})

function getCurrentPos(): { x: number; y: number } {
  return { x: posX, y: posY }
}

// 甩判定：最近 150ms 的平均速度（px/ms）。阈值参考移动端 onFling 的常见取值。
const FLUNG_SPEED = 1.2
function isFlung(recent: Array<{ t: number; x: number; y: number }>): boolean {
  if (recent.length < 2) return false
  const first = recent[0]!
  const last = recent[recent.length - 1]!
  const dt = last.t - first.t
  if (dt <= 0) return false
  return Math.hypot(last.x - first.x, last.y - first.y) / dt >= FLUNG_SPEED
}

// ---------- 拖拽（纯 transform，零 IPC） ----------
interface DragState {
  startX: number
  startY: number
  lastX: number
  lastY: number
  startTime: number
  moved: boolean
  pointerId: number
  totalDx: number
  totalDy: number
  baseX: number
  baseY: number
  /** 按下时的窗口坐标，用于判断点了哪个部位 */
  downX: number
  downY: number
  /** 最近 150ms 的移动轨迹，用于判断「甩」 */
  recent: Array<{ t: number; x: number; y: number }>
}
let dragState: DragState | null = null

ball.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || isDrawing) return
  e.preventDefault()
  try {
    ball.setPointerCapture(e.pointerId)
  } catch {
    /* 合成事件下会抛 NotFoundError，不能中断点击流程 */
  }
  dragState = {
    startX: e.clientX,
    startY: e.clientY,
    lastX: e.clientX,
    lastY: e.clientY,
    startTime: Date.now(),
    moved: false,
    pointerId: e.pointerId,
    totalDx: 0,
    totalDy: 0,
    baseX: posX,
    baseY: posY,
    downX: e.clientX,
    downY: e.clientY,
    recent: [],
  }
  window.logger.info('ball.drag', `start pos=${posX},${posY}`)
  ball.classList.remove('idle')
  ball.classList.add('grabbing')
  loco = grabLoco(loco)
  syncLocoPosition(loco, posX, posY)
  dispatch({ type: 'drag-start', now: Date.now() })
})

ball.addEventListener('pointermove', (e) => {
  if (!dragState) return
  const dx = e.clientX - dragState.lastX
  const dy = e.clientY - dragState.lastY
  dragState.lastX = e.clientX
  dragState.lastY = e.clientY
  if (Math.abs(e.clientX - dragState.startX) > 3 || Math.abs(e.clientY - dragState.startY) > 3) {
    dragState.moved = true
  }
  const now = Date.now()
  dragState.recent.push({ t: now, x: e.clientX, y: e.clientY })
  dragState.recent = dragState.recent.filter((p) => now - p.t <= 150)
  if (dragState.moved) {
    dragState.totalDx += dx
    dragState.totalDy += dy
    setBallTransform(dragState.baseX + dragState.totalDx, dragState.baseY + dragState.totalDy)
    loco = syncLocoPosition(loco, posX, posY)
    updateMenuLayout()
  }
})

ball.addEventListener('pointerup', async () => {
  if (!dragState) return
  const wasMoved = dragState.moved
  const elapsed = Date.now() - dragState.startTime
  const pointerId = dragState.pointerId
  const recent = dragState.recent
  const clickX = dragState.downX
  const clickY = dragState.downY
  dragState = null
  try {
    ball.releasePointerCapture(pointerId)
  } catch {
    /* ignore */
  }

  const endNow = Date.now()
  const flung = wasMoved && isFlung(recent)
  // 释放速度决定抛掷轨迹（px/s）；用最近 150ms 的平均速度
  const rel = recent.length >= 2 ? recent[recent.length - 1]! : null
  const firstPt = recent[0]
  const dtSec = rel && firstPt ? Math.max(0.016, (rel.t - firstPt.t) / 1000) : 0
  const vx = rel && firstPt ? Math.max(-1800, Math.min(1800, (rel.x - firstPt.x) / dtSec)) : 0
  const vy = rel && firstPt ? Math.max(-1800, Math.min(1800, (rel.y - firstPt.y) / dtSec)) : 0
  loco = syncLocoPosition(loco, posX, posY)
  // 只有真正拖动过才进入自由落体；单纯点一下不应该让猫从当前位置掉到地面
  if (wasMoved) {
    loco = releaseLoco(loco, vx, vy, endNow, bounds, wasMoved)
  } else {
    loco = { ...loco, state: 'idle', plan: null, vx: 0, vy: 0, nextDecisionAt: endNow + 20_000 }
  }
  window.logger.info('ball.drag', `end moved=${wasMoved} elapsed=${elapsed}ms flung=${flung} pos=${posX},${posY}`)

  // 先让状态机处理（甩 → dizzy 台词由状态机触发）
  dispatch({ type: 'drag-end', now: endNow, flung })

  if (!wasMoved && elapsed < 300) {
    // 按落点分区：摸头 / 戳身体 / 挠脚 → 不同动作与台词
    const nx = (clickX - posX) / BALL_SIZE
    const ny = (clickY - posY) / BALL_SIZE
    const view = loco.state === 'idle' ? 'front' : 'side'
    const zone = zoneAt(view, nx, ny)
    const reaction = reactionFor(zone)
    const nowMs = Date.now()
    if (reaction.action === 'pat') {
      patUntil = nowMs + 1600
      playSound('pat')
    } else if (reaction.action === 'grumble') {
      grumbleUntil = nowMs + 1400
      playSound('soft')
    } else {
      playSound('pat')
    }
    dispatch({ type: 'click', now: nowMs })
    ball.setAttribute('data-zone', zone)
    // 分区台词：摸头说 pat 组，挠脚说 grumble 组，戳身体保持普通点击
    if (zone === 'head') speak(pickBucket('tap', nowMs, false, 'pat'), nowMs)
    else if (zone === 'feet') speak(pickBucket('tap', nowMs, false, 'grumble'), nowMs)
    void window.api.openAiInput()
  } else if (wasMoved) {
    await window.api.savePosition(posX, posY)
    updateOrbitEdges()
  }
  ball.classList.remove('grabbing')
  ball.classList.add('idle')
})

ball.addEventListener('pointercancel', () => {
  if (dragState) dispatch({ type: 'drag-end', now: Date.now(), flung: false })
  dragState = null
  ball.classList.remove('grabbing')
  ball.classList.add('idle')
})

// ---------- 右键 → 打开对话 ----------
ball.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (isDrawing) return
  window.logger.info('ball.contextmenu', 'openAiInput')
  void window.api.openAiInput()
})

// ---------- 猫边玻璃面板 ----------
const menuItems = document.querySelectorAll<HTMLElement>('.menu-item')
let orbitLatchTimer = 0

function openOrbit(): void {
  clearTimeout(orbitLatchTimer)
  updateMenuLayout()
  ball.classList.add('orbit-open')
  scheduleHitReport()
}
function scheduleCloseOrbit(): void {
  clearTimeout(orbitLatchTimer)
  // 鼠标从猫移到面板会经过空隙，单纯 :hover 会让菜单闪烁
  orbitLatchTimer = window.setTimeout(() => {
    orbitLatchTimer = 0
    ball.classList.remove('orbit-open')
    scheduleHitReport()
  }, 220)
}
function closeOrbitNow(): void {
  clearTimeout(orbitLatchTimer)
  orbitLatchTimer = 0
  ball.classList.remove('orbit-open')
  scheduleHitReport()
}
ball.addEventListener('pointerenter', () => {
  dispatch({ type: 'pointer-enter', now: Date.now() })
  openOrbit()
})
ball.addEventListener('pointerleave', () => {
  scheduleCloseOrbit()
  // 离开 2 秒后才从 curious 落回，避免在猫和面板之间移动时情绪抖动
  window.setTimeout(() => dispatch({ type: 'pointer-leave', now: Date.now() }), 2000)
})
if (petMenu) {
  petMenu.addEventListener('pointerenter', openOrbit)
  petMenu.addEventListener('pointerleave', scheduleCloseOrbit)
}

menuItems.forEach((item) => {
  item.addEventListener('click', (e) => {
    e.stopPropagation()
    e.preventDefault()
    const action = item.getAttribute('data-action')
    window.logger.info('ball.menu', `action=${action}`)
    void handleMenuAction(action)
  })
  item.addEventListener('pointerdown', (e) => e.stopPropagation())
})

const MENU_W = 236
const MENU_H = 236
const MENU_GAP = 18
const MENU_MARGIN = 8
const MENU_COMPACT_MAX = 200

// 根据猫的位置决定面板朝哪边滑出
function updateMenuLayout(): void {
  if (!petMenu) return
  const pos = getCurrentPos()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const ballRight = pos.x + BALL_SIZE
  const ballBottom = pos.y + BALL_SIZE

  const roomRight = vw - ballRight - MENU_GAP - MENU_MARGIN
  const roomLeft = pos.x - MENU_GAP - MENU_MARGIN
  const roomAbove = ballBottom - MENU_MARGIN

  let left = false
  if (roomRight < MENU_W && roomLeft >= roomRight) left = true

  const compact = (left ? roomLeft : roomRight) < MENU_W && (left ? roomLeft : roomRight) >= MENU_COMPACT_MAX
  const up = roomAbove < MENU_H
  petMenu.classList.toggle('menu-compact', compact)
  petMenu.classList.toggle('menu-up', up)
  petMenu.classList.toggle('menu-left', left)

  if (ball.classList.contains('orbit-open')) scheduleHitReport()
}

// 把「猫 + 面板」的外接矩形合成给主进程（默认只按猫身 ±40 判定）
let lastRegion = ''
function reportHitRegion(): void {
  if (!petMenu) return
  let region: { x: number; y: number; w: number; h: number } | null = null
  if (ball.classList.contains('orbit-open')) {
    const r = petMenu.getBoundingClientRect()
    const b = ball.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      const x0 = Math.min(b.left, r.left)
      const y0 = Math.min(b.top, r.top)
      const x1 = Math.max(b.right, r.right)
      const y1 = Math.max(b.bottom, r.bottom)
      region = {
        x: Math.round(x0) - 10,
        y: Math.round(y0) - 10,
        w: Math.round(x1 - x0) + 20,
        h: Math.round(y1 - y0) + 20,
      }
    }
  }
  const key = region ? `${region.x},${region.y},${region.w},${region.h}` : 'none'
  if (key === lastRegion) return
  lastRegion = key
  try {
    window.api.setHitRegion(region)
  } catch {
    /* ignore */
  }
}

function updateOrbitEdges(): void {
  const pos = getCurrentPos()
  const vw = window.innerWidth
  const vh = window.innerHeight
  ball.classList.toggle('edge-top', pos.y < 70)
  ball.classList.toggle('edge-bottom', pos.y + BALL_SIZE > vh - 46)
  ball.classList.toggle('edge-left', pos.x < 96)
  ball.classList.toggle('edge-right', pos.x + BALL_SIZE > vw - 24)
  updateMenuLayout()
}

let hitReportTimer = 0
function scheduleHitReport(): void {
  if (hitReportTimer) return
  hitReportTimer = window.setTimeout(() => {
    hitReportTimer = 0
    reportHitRegion()
  }, 40)
}

async function handleMenuAction(action: string | null): Promise<void> {
  closeOrbitNow()
  reportHitRegion()
  if (action === 'chat') {
    window.logger.info('ball.menu', 'chat → open AI input')
    await window.api.openAiInput()
    return
  }
  if (action === 'settings') {
    await window.api.openSettings()
  }
}

// ---------- 动画预览（设置页用） ----------
window.api.onPreviewBallAnim(() => {
  if (isDrawing) return
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  isDrawing = true
  ball.classList.add('previewing')
  window.logger.info('ball.preview', 'anim preview')
  setTimeout(() => {
    ball.classList.remove('previewing')
    isDrawing = false
  }, 900)
})

// ---------- 桌面形象（S0 仅猫） ----------
function applyPersona(): void {
  if (ballInner) ballInner.setAttribute('data-persona', 'cat')
}

window.api.onPersonaChanged((_name) => {
  applyPersona()
  window.logger.info('ball.persona', 'changed')
})

// ---------- 设置变更（动画开关 / 名字） ----------
function applyAnimations(enabled: boolean): void {
  animationsEnabled = enabled
  ball.setAttribute('data-anim', enabled ? 'on' : 'off')
}

window.api.onConfigChanged((key, value) => {
  if (key === 'animations') applyAnimations(value !== false)
  if (key === 'sound') setSoundEnabled(value !== false)
  if (key === 'pet') {
    const name = (value as { name?: string } | null)?.name
    if (name) window.logger.info('ball.pet', `name=${name}`)
  }
})

// ---------- 启动 ----------
ball.classList.add('idle')
paintMood()

;(async () => {
  try {
    await window.api.getPersona()
  } catch {
    /* ignore */
  }
  applyPersona()

  // 加载占位皮肤（图集 + manifest）；失败时角色不可见，但不影响其他功能
  try {
    const m = skinManifest as { frameSize?: { w: number; h: number }; assets?: { columns?: number } }
    renderer = await loadSkin(canvas, {
      manifest: skinManifest as never,
      atlasUrl,
      columns: m.assets?.columns,
      frameSize: m.frameSize,
    })
    paintClip()
    window.logger.info('ball.skin', 'placeholder loaded')
  } catch (e) {
    window.logger.error('ball.skin', 'load failed: ' + ((e as Error).message || e))
  }

  // 恢复跨重启的情绪：上次交互时间 + 上次早安日期
  try {
    const pet = await window.api.getConfig('pet')
    if (pet) {
      petState = {
        ...initPetState(pet.lastInteractAt || Date.now()),
        lastGreetDate: pet.lastGreetDate || '',
      }
      // 不把「旧状态」当成交互事件，直接按当前时间推导
      dispatch({ type: 'tick', now: Date.now() })
    }
  } catch (e) {
    window.logger.warn('ball.init', `pet state load failed: ${(e as Error).message}`)
  }

  try {
    const anim = await window.api.getConfig('animations')
    applyAnimations(anim !== false)
    try {
      const snd = await window.api.getConfig('sound')
      setSoundEnabled(snd !== false)
    } catch {
      setSoundEnabled(true)
    }
  } catch {
    applyAnimations(true)
  }

  try {
    const saved = await window.api.getConfig('position')
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      setBallTransform(saved.x, saved.y)
      loco = { ...initLoco(saved.x, saved.y, Date.now()), y: saved.y }
    } else {
      // 第一次启动：放右下角
      const screen = await window.api.getScreenInfo()
      if (screen) {
        const def = { x: screen.width - BALL_SIZE - 40, y: screen.height - BALL_SIZE - 40 }
        setBallTransform(def.x, def.y)
        await window.api.savePosition(def.x, def.y)
      }
    }
    updateOrbitEdges()
  } catch (e) {
    console.warn('读取位置失败:', e)
    window.logger.warn('ball.init', `load failed: ${(e as Error).message}`)
  }
})()
