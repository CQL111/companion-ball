// ball.js - 悬浮球渲染器
// 设计要点：
// - 窗口是全屏透明的，body 走 pointer-events:none 让点击穿透到桌面
// - 球本身 pointer-events:auto，只有它能点击
// - 球的位置完全由 CSS transform 控制，零 IPC 即可丝滑拖拽/动画
// - 仅在拖拽结束时 IPC 落盘位置；卡片显示时再传一次球的屏幕坐标

const ball = document.getElementById('ball');
const ballInner = document.getElementById('ball-inner');

const BALL_SIZE = 80;

// ---------- 表情 ----------
// 5→大笑 4→微笑 3-2→不笑 1→哭
function setMood(score) {
  let mood = 'neutral';
  if (score >= 5) mood = 'laugh';
  else if (score >= 4) mood = 'smile';
  else if (score <= 1) mood = 'cry';
  ballInner.setAttribute('data-mood', mood);
}

// ---------- 颜色（CSS 变量驱动） ----------
function hexToRgb(hex) {
  const m = String(hex || '').replace('#', '').match(/.{2}/g);
  if (!m || m.length < 3) return null;
  return { r: parseInt(m[0], 16), g: parseInt(m[1], 16), b: parseInt(m[2], 16) };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
function setColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return;
  const { r, g, b } = rgb;
  ball.style.setProperty('--ball-light', rgbToHex(r + (255 - r) * 0.55, g + (255 - g) * 0.55, b + (255 - b) * 0.55));
  ball.style.setProperty('--ball-mid', rgbToHex(r, g, b));
  ball.style.setProperty('--ball-dark', rgbToHex(r * 0.75, g * 0.75, b * 0.75));
  ball.style.setProperty('--ball-shadow', `rgba(${r}, ${g}, ${b}, 0.4)`);
}


// 交互锁：拖拽/预览动画期间不响应点击
let isDrawing = false;

// ---------- 位置（CSS transform） ----------
let posX = 0, posY = 0; // 当前 transform 位置（屏幕坐标）

// 位置同步给主进程（用于点击穿透决策 + 拖拽兜底落盘）。
// 用 rAF 合并到每帧最多一次：60fps 的 IPC + 主进程日志会拖慢拖拽并刷爆日志。
let posSyncPending = false;
function syncPosToMain() {
  if (posSyncPending) return;
  posSyncPending = true;
  requestAnimationFrame(() => {
    posSyncPending = false;
    window.api.updateBallPos(posX, posY);
  });
}

function setBallTransform(x, y, extra = '') {
  posX = x;
  posY = y;
  ball.style.transform = `translate(${x}px, ${y}px)${extra}`;
  syncPosToMain();
}

function getCurrentPos() {
  return { x: posX, y: posY };
}

// ---------- 拖拽（纯 transform，零 IPC） ----------
let dragState = null;

ball.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (isDrawing) return;
  e.preventDefault();
  // setPointerCapture 在部分输入设备/合成事件下会抛 NotFoundError，不能让它中断点击流程
  try { ball.setPointerCapture(e.pointerId); } catch {}
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
  };
  window.logger.info('ball.drag', `start pos=${posX},${posY}`);
  ball.classList.remove('idle');
  ball.classList.add('grabbing');
});

ball.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.lastX;
  const dy = e.clientY - dragState.lastY;
  dragState.lastX = e.clientX;
  dragState.lastY = e.clientY;
  if (Math.abs(e.clientX - dragState.startX) > 3 || Math.abs(e.clientY - dragState.startY) > 3) {
    dragState.moved = true;
  }
  if (dragState.moved) {
    dragState.totalDx += dx;
    dragState.totalDy += dy;
    setBallTransform(dragState.baseX + dragState.totalDx, dragState.baseY + dragState.totalDy);
    updateMenuLayout();
  }
});

ball.addEventListener('pointerup', async (e) => {
  if (!dragState) return;
  const wasMoved = dragState.moved;
  const elapsed = Date.now() - dragState.startTime;
  const pointerId = dragState.pointerId;
  dragState = null;
  try { ball.releasePointerCapture(pointerId); } catch {}

  window.logger.info('ball.drag', `end moved=${wasMoved} elapsed=${elapsed}ms pos=${posX},${posY}`);

  if (!wasMoved && elapsed < 300) {
    // 单击猫：打开对话（S0 无抽签）
    window.api.openAiInput();
  } else if (wasMoved) {
    // 仅在拖拽结束时 IPC 落盘位置
    await window.api.savePosition(posX, posY);
    updateOrbitEdges();
  }
  ball.classList.remove('grabbing');
  ball.classList.add('idle');
});

ball.addEventListener('pointercancel', () => {
  dragState = null;
  ball.classList.remove('grabbing');
  closeOrbitNow();
  ball.classList.add('idle');
});

// ---------- 右键 → AI 运势对话 ----------
ball.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (isDrawing) return;
  window.logger.info('ball.contextmenu', 'openAiInput');
  window.api.openAiInput();
});

// ---------- 猫边玻璃面板（四行入口） ----------
const menuItems = document.querySelectorAll('.menu-item');
const petMenu = document.getElementById('pet-menu');
// 开合闩：鼠标从猫移到面板时会经过空隙，单纯 :hover 会让菜单闪烁消失
let orbitLatchTimer = 0;
function openOrbit() {
  clearTimeout(orbitLatchTimer);
  updateMenuLayout(); // 位置可能在上一轮抽签/归位后变化，先刷新面板朝向
  ball.classList.add('orbit-open');
  scheduleHitReport();
}
function scheduleCloseOrbit() {
  clearTimeout(orbitLatchTimer);
  orbitLatchTimer = setTimeout(() => {
    orbitLatchTimer = 0;
    ball.classList.remove('orbit-open');
    scheduleHitReport();
  }, 220);
}
function closeOrbitNow() {
  clearTimeout(orbitLatchTimer);
  orbitLatchTimer = 0;
  ball.classList.remove('orbit-open');
  scheduleHitReport();
}
ball.addEventListener('pointerenter', openOrbit);
ball.addEventListener('pointerleave', scheduleCloseOrbit);
if (petMenu) {
  petMenu.addEventListener('pointerenter', openOrbit);
  petMenu.addEventListener('pointerleave', scheduleCloseOrbit);
}

menuItems.forEach((item) => {
  item.addEventListener('click', (e) => {
    e.stopPropagation(); // 阻止冒泡到球的 pointerup（避免触发普通 handleClick）
    e.preventDefault();
    const action = item.getAttribute('data-action');
    window.logger.info('ball.menu', `action=${action}`);
    handleMenuAction(action);
  });
  // 面板行上不能启动拖拽
  item.addEventListener('pointerdown', (e) => e.stopPropagation());
});

// 面板尺寸（CSS 里 --menu-w 236 / compact 152，高约 4×50 + padding）
const MENU_W = 236, MENU_H = 236, MENU_GAP = 18, MENU_MARGIN = 8;
const MENU_COMPACT_MAX = 200; // 按钮按「右侧、上对齐」估算的可用宽度：桌面宽 - 猫右边距 - 面板

// 根据猫的位置决定面板朝哪边滑出：
//   默认在右侧、底部对齐；右边放不下 → 左侧（用 bottom 对齐，避免向上长高）；
//   仍放不下 → 压缩成「图标 + 名称」两列
function updateMenuLayout() {
  if (!petMenu) return;
  const pos = getCurrentPos();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ballRight = pos.x + BALL_SIZE;
  const ballBottom = pos.y + BALL_SIZE;

  const roomRight = vw - ballRight - MENU_GAP - MENU_MARGIN;
  const roomLeft = pos.x - MENU_GAP - MENU_MARGIN;
  const roomAbove = ballBottom - MENU_MARGIN;

  let left = false;
  if (roomRight < MENU_W && roomLeft >= roomRight) left = true;

  const compact = (left ? roomLeft : roomRight) < MENU_W && (left ? roomLeft : roomRight) >= MENU_COMPACT_MAX;
  const width = compact ? 152 : MENU_W;

  // 若两侧都放不下（窄屏/贴边），保持右侧并压缩；再不济贴到屏幕边
  // 默认底部对齐（面板底边与猫底边齐平、向上展开）；猫贴近屏幕顶部时改为顶部对齐向下展开
  const up = roomAbove < MENU_H;
  petMenu.classList.toggle('menu-compact', compact);
  petMenu.classList.toggle('menu-up', up);
  petMenu.classList.toggle('menu-left', left);
  petMenu._width = width;
  petMenu._height = MENU_H;

  // 面板打开时把「猫 + 面板」的包围盒告诉主进程，扩大点击穿透热区
  if (ball.classList.contains('orbit-open')) scheduleHitReport();
}

// 把菜单打开时的外接矩形合成给主进程（默认只按猫身 ±40 判定）。
// 直接读面板的真实 rect，避免估算尺寸和 CSS 不一致
let lastRegion = '';
function reportHitRegion() {
  if (!petMenu) return;
  let region = null;
  if (ball.classList.contains('orbit-open')) {
    const r = petMenu.getBoundingClientRect();
    const b = ball.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      // #ball 带 translate，getBoundingClientRect 已经是窗口内（≈屏幕）坐标，不要再加 pos
      const x0 = Math.min(b.left, r.left);
      const y0 = Math.min(b.top, r.top);
      const x1 = Math.max(b.right, r.right);
      const y1 = Math.max(b.bottom, r.bottom);
      region = {
        x: Math.round(x0) - 10,
        y: Math.round(y0) - 10,
        w: Math.round(x1 - x0) + 20,
        h: Math.round(y1 - y0) + 20,
      };
    }
  }
  const key = region ? `${region.x},${region.y},${region.w},${region.h}` : 'none';
  if (key === lastRegion) return;
  lastRegion = key;
  try { window.api.setHitRegion(region); } catch {}
}

// 猫贴边时额外调整气泡/面板朝向（保留原有方法名，供拖拽结束调用）
function updateOrbitEdges() {
  const pos = getCurrentPos();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  ball.classList.toggle('edge-top', pos.y < 70);
  ball.classList.toggle('edge-bottom', pos.y + BALL_SIZE > vh - 46);
  ball.classList.toggle('edge-left', pos.x < 96);
  ball.classList.toggle('edge-right', pos.x + BALL_SIZE > vw - 24);
  updateMenuLayout();
}

// 面板开合/移动时节流上报热区（避免 80ms 轮询期间频繁 IPC）
let hitReportTimer = 0;
function scheduleHitReport() {
  if (hitReportTimer) return;
  hitReportTimer = setTimeout(() => {
    hitReportTimer = 0;
    reportHitRegion();
  }, 40);
}

async function handleMenuAction(action) {
  closeOrbitNow();
  reportHitRegion();
  if (action === 'chat') {
    window.logger.info('ball.menu', 'chat → open AI input');
    window.api.openAiInput();
    return;
  }
  if (action === 'settings') {
    window.api.openSettings();
  }
}

// 卡片关闭后，球动画归位到原始位置
function resetBallToOriginal() {
  if (!originalBallPos) return;
  const target = originalBallPos;
  originalBallPos = null;
  const start = getCurrentPos();
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const DIST = Math.hypot(dx, dy);
  // 距离太短就不动画，直接 set
  if (DIST < 5) {
    setBallTransform(target.x, target.y);
    window.api.savePosition(target.x, target.y);
    return;
  }
  const DURATION = Math.min(420, 200 + DIST * 0.3);
  const startTime = performance.now();
  function tick(now) {
    const elapsed = now - startTime;
    const t = Math.min(1, elapsed / DURATION);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    const x = Math.round(start.x + dx * eased);
    const y = Math.round(start.y + dy * eased);
    setBallTransform(x, y);
    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      setBallTransform(target.x, target.y);
      window.api.savePosition(target.x, target.y);
    }
  }
  requestAnimationFrame(tick);
}

window.api.onResetBall(() => {
  resetBallToOriginal();
});

// ---------- 动画预览（设置页用） ----------
window.api.onPreviewBallAnim(() => {
  if (isDrawing) return;
  isDrawing = true;
  ball.classList.add('previewing');
  window.logger.info('ball.preview', 'anim preview');
  setTimeout(() => {
    ball.classList.remove('previewing');
    isDrawing = false;
  }, 900);
});

// OS 层点击穿透：见 setBallTransform 上方的 mouse tracking 区块。
// 球窗口默认 OS 层忽略鼠标（主进程启动时设置）；
// renderer 收到 forwarded mousemove 后判断光标是否在球上，动态切回 / 切走。

// ---------- 启动 ----------
ball.classList.add('idle');

// ---------- 桌面形象（猫 / 狗 / 财神 / 签筒） ----------
function applyPersona(name) {
  const valid = ['cat', 'dog', 'caishen', 'lots'];
  const next = valid.includes(name) ? name : 'cat';
  if (ballInner) ballInner.setAttribute('data-persona', next);
}

window.api.onPersonaChanged((name) => {
  applyPersona(name);
  window.logger.info('ball.persona', 'changed to ' + name);
});

(async () => {
  // 0. 应用桌面形象
  try { applyPersona(await window.api.getPersona()); } catch {}

  // 1. 读取保存的位置
  try {
    const saved = await window.api.getConfig('position');
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      setBallTransform(saved.x, saved.y);
    } else {
      // 第一次启动：放右下角
      const screen = await window.api.getScreenInfo();
      if (screen) {
        const def = {
          x: screen.width  - BALL_SIZE - 40,
          y: screen.height - BALL_SIZE - 40,
        };
        setBallTransform(def.x, def.y);
        await window.api.savePosition(def.x, def.y);
      }
    }
    updateOrbitEdges();
  } catch (e) {
    console.warn('读取位置失败:', e);
    window.logger.warn('ball.init', `load failed: ${e.message}`);
  }

  // 默认状态（粉色 + 微笑）保持，角色外观由用户/后续人格系统驱动
})();
