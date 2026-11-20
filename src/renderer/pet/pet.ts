// pet.ts - 团子猫渲染器（命令式，不经 React）
// 设计要点：
// - 窗口全屏透明，body 走 pointer-events:none 让点击穿透到桌面
// - 球本身 pointer-events:auto，只有它能点击
// - 球的位置完全由 CSS transform 控制，零 IPC 即可丝滑拖拽
// - 仅在拖拽结束时 IPC 落盘位置；菜单打开时上报「猫 + 面板」热区

import '../renderer-logger'

const ball = document.getElementById('ball') as HTMLDivElement
const ballInner = document.getElementById('ball-inner') as HTMLDivElement
const petMenu = document.getElementById('pet-menu') as HTMLElement | null

const BALL_SIZE = 80

// 交互锁：预览动画期间不响应点击
let isDrawing = false

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

function getCurrentPos(): { x: number; y: number } {
  return { x: posX, y: posY }
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
  }
  window.logger.info('ball.drag', `start pos=${posX},${posY}`)
  ball.classList.remove('idle')
  ball.classList.add('grabbing')
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
  if (dragState.moved) {
    dragState.totalDx += dx
    dragState.totalDy += dy
    setBallTransform(dragState.baseX + dragState.totalDx, dragState.baseY + dragState.totalDy)
    updateMenuLayout()
  }
})

ball.addEventListener('pointerup', async () => {
  if (!dragState) return
  const wasMoved = dragState.moved
  const elapsed = Date.now() - dragState.startTime
  const pointerId = dragState.pointerId
  dragState = null
  try {
    ball.releasePointerCapture(pointerId)
  } catch {
    /* ignore */
  }

  window.logger.info('ball.drag', `end moved=${wasMoved} elapsed=${elapsed}ms pos=${posX},${posY}`)

  if (!wasMoved && elapsed < 300) {
    void window.api.openAiInput()
  } else if (wasMoved) {
    await window.api.savePosition(posX, posY)
    updateOrbitEdges()
  }
  ball.classList.remove('grabbing')
  ball.classList.add('idle')
})

ball.addEventListener('pointercancel', () => {
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
ball.addEventListener('pointerenter', openOrbit)
ball.addEventListener('pointerleave', scheduleCloseOrbit)
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

// ---------- 启动 ----------
ball.classList.add('idle')

;(async () => {
  try {
    await window.api.getPersona()
  } catch {
    /* ignore */
  }
  applyPersona()

  try {
    const saved = await window.api.getConfig('position')
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      setBallTransform(saved.x, saved.y)
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
