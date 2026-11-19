// main.js - 主进程
// 桌面陪伴 · 团子猫（S0：角色壳 + AI 对话骨架）
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, nativeImage, Notification, shell, dialog } = require('electron');
const crypto = require('crypto');
const path = require('path');
const Store = require('electron-store');
const ai = require('./src/js/ai');
const logger = require('./src/js/logger');
const LogWatcher = require('./src/js/watcher');
const selfCheck = require('./src/js/selfCheck');
const localLLM = require('./src/js/localLLM');
const onlineConfig = require('./src/js/onlineConfig');
const agent = require('./src/js/agent');

// Windows 通知必须先设 appId（在 ready 之前）
app.setAppUserModelId('com.companion.ball');

// 单实例锁：第二次启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// 持久化
const store = new Store({
  name: 'config',
  defaults: {
    position: null,        // { x, y } 屏幕坐标
    autoStart: false,
    aiConfig: { baseUrl: '', token: '', model: '' },
    localModel: '',        // 用户选择的本地模型名（空 = 用线上）
    installId: '',         // 首次启动生成，本机 ID
    persona: 'cat',        // 桌面形象：cat | dog | caishen | lots
    agentChat: { messages: [], scene: '', updatedAt: 0 },
    consentVersion: 0,     // 已同意的协议版本；与 AGREEMENT_VERSION 不一致时首次启动需重新同意
  },
});

// 全局状态
let ballWindow = null;
let tray = null;
let isQuitting = false;
// 球在 transform 坐标里的当前位置（renderer 通过 IPC 更新）
let currentBallPos = { x: 0, y: 0 };
const BALL_HALO = 40;
let lastIgnoreState = null;
// 菜单打开时渲染端上报的「猫 + 面板」外接矩形（屏幕坐标，null = 只用猫身热区）
let ballHitRegion = null;


const BALL_SIZE = 80;
const AI_INPUT_WIDTH = 380;
const AI_INPUT_HEIGHT = 480;
let agentHistory = [];
let agentScene = '';


function loadAgentChat() {
  const c = store.get('agentChat') || agent.emptyAgentChat();
  agentHistory = agent.trimByUserTurns(c.messages || []);
  agentScene = c.scene || '';
}

function saveAgentChat() {
  store.set('agentChat', {
    messages: agent.trimByUserTurns(agentHistory),
    scene: agentScene || '',
    updatedAt: Date.now(),
  });
}

function clearAgentChat() {
  agentHistory = [];
  agentScene = '';
  store.set('agentChat', agent.emptyAgentChat());
}

loadAgentChat();

// 旧版把 API Key 写在 aiConfig.encryptedToken（实际是 base64，非真加密）。
// 新版统一用明文 aiConfig.token；首次启动时迁移一次，避免用户已保存的 Key 丢失。
function migrateLegacyAiConfig() {
  const cfg = store.get('aiConfig');
  if (!cfg || typeof cfg !== 'object') return;
  const hasToken = typeof cfg.token === 'string' && cfg.token.trim();
  const legacy = cfg.encryptedToken;
  if (!hasToken && typeof legacy === 'string' && legacy) {
    try {
      const token = Buffer.from(legacy, 'base64').toString('utf8').trim();
      // OpenAI 兼容服务的 Key 都形如 sk-...；不是这个格式就不猜，等用户重新填写
      if (/^sk-[A-Za-z0-9_\-]+$/.test(token)) {
        store.set('aiConfig', { ...cfg, token, encryptedToken: undefined, tokenObfuscated: undefined });
        logger.info('aiConfig', 'migrated legacy encryptedToken → token');
      } else {
        logger.warn('aiConfig', 'legacy encryptedToken present but format unrecognized, skipped');
      }
    } catch (e) {
      logger.warn('aiConfig', `legacy token migration failed: ${e.message}`);
    }
  } else if (cfg.encryptedToken !== undefined || cfg.tokenObfuscated !== undefined) {
    // 已经有新字段了，顺手清掉旧字段
    store.set('aiConfig', { ...cfg, encryptedToken: undefined, tokenObfuscated: undefined });
  }
}
migrateLegacyAiConfig();

function ensureInstallId() {
  const cur = store.get('installId');
  if (typeof cur === 'string' && cur.length >= 8) return cur;
  const id = crypto.randomUUID();
  store.set('installId', id);
  logger.info('installId', 'generated');
  return id;
}
ensureInstallId();

// 统一的 AI 配置入口：有可用 Ollama 则本地；否则设置面板里的线上配置 / `.env`
async function resolveAiConfig() {
  const localModel = store.get('localModel') || '';
  if (localModel) {
    const ok = await localLLM.checkLocal();
    if (ok) {
      return {
        baseUrl: localLLM.LOCAL_BASE_URL,
        token: localLLM.LOCAL_TOKEN,
        model: localModel,
        source: 'local',
      };
    }
    logger.warn('resolveAiConfig', `local model "${localModel}" configured but Ollama unavailable, fallback to online`);
  }
  // 开发态（npm start）本机 .env 优先，避免旧 Key 盖住新配置；发布版设置面板优先
  return { ...onlineConfig.resolve(store.get('aiConfig'), { preferEnv: !app.isPackaged }), source: 'online' };
}

// 发布版可能内置了 Key；用户自己的 Key 失效时自动回退，并明确告知
let aiFallbackNotice = '';

function builtinAiConfig() {
  const bundled = typeof onlineConfig.loadBundled === 'function' ? onlineConfig.loadBundled() : null;
  if (bundled && bundled.token) {
    return { baseUrl: bundled.baseUrl, token: bundled.token, model: bundled.model, source: 'bundled' };
  }
  if (onlineConfig.token) {
    return { baseUrl: onlineConfig.baseUrl, token: onlineConfig.token, model: onlineConfig.model, source: 'env' };
  }
  return null;
}

function isUserKeyActive() {
  const saved = store.get('aiConfig') || {};
  const merged = onlineConfig.resolve(saved, { preferEnv: !app.isPackaged });
  return merged.tokenSource === 'user' && !!(saved.token || '').trim();
}

// 调用 AI：若使用用户的 Key 且鉴权失败，回退到内置 Key 重试一次
async function withAiFallback(invoke) {
  const cfg = await resolveAiConfig();
  aiFallbackNotice = '';
  try {
    return { cfg, result: await invoke(cfg), usedFallback: false };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const authFailed = /AUTH_FAILED|HTTP_40[13]/.test(msg);
    if (!authFailed || cfg.source !== 'online' || !isUserKeyActive()) throw e;
    const builtin = builtinAiConfig();
    if (!builtin) throw e;
    logger.warn('ai.fallback', 'user key auth failed, retry with builtin key');
    aiFallbackNotice = '你的 API Key 已失效，本次已临时使用应用内置 Key；请到设置更新。';
    const result = await invoke({ ...builtin, source: 'online' });
    return { cfg: builtin, result, usedFallback: true };
  }
}

// 启动参数：--hidden 用于开机自启时不显示球
const startHidden = process.argv.includes('--hidden');

// 主显示器 bounds（球窗口覆盖整个屏幕）
function getPrimaryBounds() {
  return screen.getPrimaryDisplay().bounds;
}

// 球在 transform 坐标系下的默认位置（屏幕右下角）
function getDefaultPosition() {
  const b = getPrimaryBounds();
  return {
    x: b.width  - BALL_SIZE - 40,
    y: b.height - BALL_SIZE - 40,
  };
}

// 把保存的 transform 位置 clamp 到屏幕内
function clampPosition(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
    return getDefaultPosition();
  }
  const b = getPrimaryBounds();
  return {
    x: Math.max(0, Math.min(pos.x, b.width  - BALL_SIZE)),
    y: Math.max(0, Math.min(pos.y, b.height - BALL_SIZE)),
  };
}

// ---------- 窗口创建 ----------
function createBallWindow() {
  try {
    _createBallWindowImpl();
  } catch (e) {
    logger.error('main.window', `createBallWindow failed: ${e.message}`);
    throw e;
  }
}
function _createBallWindowImpl() {
  const bounds = getPrimaryBounds();

  ballWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Electron 30+：从 Alt+Tab 列表排除
  if (typeof ballWindow.setExcludedFromAltTab === 'function') {
    ballWindow.setExcludedFromAltTab(true);
  }

  // OS 层点击穿透：默认忽略鼠标事件（forward 让 mousemove 仍能进入 renderer，
  // renderer 据此动态切回 false 让球本身可点）。
  ballWindow.setIgnoreMouseEvents(true, { forward: true });

  ballWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  ballWindow.once('ready-to-show', () => {
    if (!startHidden) ballWindow.show();
  });

  // 形象变化后同步给渲染端（renderer 加载完成时也会主动 getPersona）
  ballWindow.webContents.once('did-finish-load', () => {
    broadcastPersona(store.get('persona') || 'cat');
  });

  // close-to-tray
  ballWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      ballWindow.hide();
    }
  });
}

// 缓存最近的球的屏幕坐标（用于卡片定位）
let lastBallScreenPos = { x: 0, y: 0 };
// 最近的渲染端 transform 位置；update-ball-pos 是 60fps 通道，不刷日志，顺带节流落盘
let lastPersistedPos = null;
let positionSaveTimer = null;

function persistBallPosition(x, y) {
  const clamped = clampPosition({ x, y });
  lastPersistedPos = clamped;
  if (positionSaveTimer) return; // 已有待写入任务，只需更新 lastPersistedPos
  positionSaveTimer = setTimeout(() => {
    positionSaveTimer = null;
    if (lastPersistedPos) store.set('position', lastPersistedPos);
  }, 400);
}

// 球的实时屏幕坐标 = 窗口原点 + transform 偏移
// 返回整数（Electron setPosition / BrowserWindow 要求整数，浮点会 conversion failure）
function getBallScreenPos() {
  const b = ballWindow && !ballWindow.isDestroyed() ? ballWindow.getBounds() : { x: 0, y: 0 };
  return {
    x: Math.round(b.x + (currentBallPos.x || 0)),
    y: Math.round(b.y + (currentBallPos.y || 0)),
  };
}


// ---------- 设置面板窗口 ----------
let settingsWindow = null;
function createSettingsWindow() {
  try {
    return _createSettingsWindowImpl();
  } catch (e) {
    logger.error('main.window', `createSettingsWindow failed: ${e.message}`);
    throw e;
  }
}
function _createSettingsWindowImpl() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 680,
    minWidth: 400,
    minHeight: 480,
    transparent: false,
    frame: true,
    title: '设置',
    alwaysOnTop: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    backgroundColor: '#141019', // 与 tokens.css 的 --bg-0 保持一致
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'src', 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  return settingsWindow;
}

// ---------- AI 输入浮窗 ----------
let aiInputWindow = null;
function createAiInputWindow() {
  try {
    return _createAiInputWindowImpl();
  } catch (e) {
    logger.error('main.window', `createAiInputWindow failed: ${e.message}`);
    throw e;
  }
}
function _createAiInputWindowImpl() {
  if (aiInputWindow && !aiInputWindow.isDestroyed()) {
    return aiInputWindow;
  }
  aiInputWindow = new BrowserWindow({
    width: AI_INPUT_WIDTH,
    height: AI_INPUT_HEIGHT,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  if (typeof aiInputWindow.setExcludedFromAltTab === 'function') {
    aiInputWindow.setExcludedFromAltTab(true);
  }
  aiInputWindow.setMenuBarVisibility(false);
  aiInputWindow.loadFile(path.join(__dirname, 'src', 'aiInput.html'));
  aiInputWindow.on('blur', () => {
    // 浮窗失焦自动关（用户点别处就收起来）
    if (aiInputWindow && !aiInputWindow.isDestroyed()) aiInputWindow.hide();
  });
  aiInputWindow.on('closed', () => { aiInputWindow = null; });
  return aiInputWindow;
}

// 浮窗定位：贴在球的右上角偏移
function positionAiInputNearBall() {
  if (!aiInputWindow || aiInputWindow.isDestroyed()) return;
  const pos = getBallScreenPos();
  const work = screen.getPrimaryDisplay().workArea;
  const w = AI_INPUT_WIDTH, h = AI_INPUT_HEIGHT;
  // 默认放在球右上
  let x = pos.x + BALL_SIZE + 8;
  let y = pos.y - 20;
  // 右边越界 → 放球左侧
  if (x + w > work.x + work.width) x = pos.x - w - 8;
  // 左边越界 → clamp
  if (x < work.x) x = work.x + 8;
  // 下边越界 → 上移
  if (y + h > work.y + work.height) y = work.y + work.height - h - 8;
  if (y < work.y) y = work.y + 8;
  aiInputWindow.setPosition(Math.round(x), Math.round(y));
}

// 打开 AI 对话浮窗（托盘 / 右键 / 设置面板共用这一条路径）
function openAiInputWindow() {
  const win = createAiInputWindow();
  positionAiInputNearBall();
  win.show();
  win.focus();
  sendAiInputFocus(win);
}

// ---------- 首次启动协议同意 ----------
// 修改协议内容时把版本 +1，用户下次启动会重新看到同意页
const AGREEMENT_VERSION = 1;
let consentWindow = null;

function needsConsent() {
  return Number(store.get('consentVersion') || 0) < AGREEMENT_VERSION;
}

function createConsentWindow() {
  if (consentWindow && !consentWindow.isDestroyed()) {
    consentWindow.show();
    consentWindow.focus();
    return consentWindow;
  }
  consentWindow = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 460,
    minHeight: 520,
    resizable: true,
    transparent: false,
    frame: true,
    title: '欢迎使用 · 桌面陪伴',
    backgroundColor: '#141019',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  consentWindow.setMenuBarVisibility(false);
  consentWindow.loadFile(path.join(__dirname, 'src', 'consent.html'));
  consentWindow.once('ready-to-show', () => consentWindow.show());
  consentWindow.on('closed', () => { consentWindow = null; });
  // 未同意就关窗 → 退出应用
  consentWindow.on('close', () => {
    if (needsConsent()) {
      isQuitting = true;
      setTimeout(() => app.quit(), 50);
    }
  });
  return consentWindow;
}

// ---------- 法律与隐私窗口 ----------
let legalWindow = null;
function createLegalWindow(docKey) {
  const key = ['privacy', 'terms', 'disclaimer', 'thirdparty'].includes(docKey) ? docKey : 'privacy';
  if (legalWindow && !legalWindow.isDestroyed()) {
    legalWindow.loadFile(path.join(__dirname, 'src', 'legal.html'), { search: 'doc=' + key });
    legalWindow.show();
    legalWindow.focus();
    return legalWindow;
  }
  legalWindow = new BrowserWindow({
    width: 760,
    height: 740,
    minWidth: 480,
    minHeight: 420,
    transparent: false,
    frame: true,
    title: '法律与隐私',
    backgroundColor: '#141019',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  legalWindow.setMenuBarVisibility(false);
  legalWindow.loadFile(path.join(__dirname, 'src', 'legal.html'), { search: 'doc=' + key });
  legalWindow.once('ready-to-show', () => legalWindow.show());
  legalWindow.on('closed', () => { legalWindow = null; });
  return legalWindow;
}

// ---------- 桌面形象 ----------
const PERSONAS = {
  cat: '猫',
  dog: '狗',
  caishen: '财神',
  lots: '签筒',
};
function broadcastPersona(name) {
  if (ballWindow && !ballWindow.isDestroyed()) {
    try { ballWindow.webContents.send('persona-changed', name); } catch {}
  }
}

// ---------- 托盘 ----------
function trayToolTipText() {
  return '桌面陪伴 · 团子猫';
}

function createTray() {
  const iconPath = path.join(__dirname, 'src', 'assets', 'tray.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('empty');
  } catch {
    // 退化：空 image
    icon = nativeImage.createEmpty();
  }

  try {
    tray = new Tray(icon);
  } catch (e) {
    console.error('Tray 创建失败:', e.message);
    logger.error('tray', `init failed: ${e.message}`);
    return;
  }

  tray.setToolTip(trayToolTipText());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: '显示悬浮球',
      click: () => {
        logger.info('main.tray', 'show ball');
        if (!ballWindow || ballWindow.isDestroyed()) createBallWindow();
        ballWindow.show();
        ballWindow.focus();
      },
    },
    {
      label: '隐藏悬浮球',
      click: () => {
        logger.info('main.tray', 'hide all');
        if (ballWindow && !ballWindow.isDestroyed()) ballWindow.hide();
        if (aiInputWindow && !aiInputWindow.isDestroyed()) aiInputWindow.hide();
      },
    },
    { type: 'separator' },
    {
      label: '聊聊天',
      click: () => {
        if (!ballWindow || ballWindow.isDestroyed()) createBallWindow();
        ballWindow.show();
        ballWindow.focus();
        openAiInputWindow();
      },
    },
    {
      label: '设置...',
      click: () => {
        createSettingsWindow();
      },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: store.get('autoStart') === true,
      enabled: app.isPackaged, // dev 模式禁用
      click: (item) => {
        store.set('autoStart', item.checked);
        applyAutoStart(item.checked);
      },
    },
    {
      label: '桌面形象',
      submenu: Object.entries(PERSONAS).map(([key, label]) => ({
        label,
        type: 'radio',
        checked: (store.get('persona') || 'cat') === key,
        click: () => {
          store.set('persona', key);
          logger.info('persona', 'tray set ' + key);
          broadcastPersona(key);
          rebuildTrayMenu();
        },
      })),
    },
    {
      label: '重置位置',
      click: () => {
        logger.info('main.tray', 'reset position');
        store.set('position', null);
        if (ballWindow && !ballWindow.isDestroyed()) {
          const pos = getDefaultPosition();
          ballWindow.setPosition(pos.x, pos.y);
          store.set('position', pos);
        }
      },
    },
    { type: 'separator' },
    {
      label: '日志级别',
      submenu: [
        { label: 'info（全部）', type: 'radio', checked: logger.getLevel() === 'info',
          click: () => { logger.setLevel('info'); rebuildTrayMenu(); } },
        { label: 'warn', type: 'radio', checked: logger.getLevel() === 'warn',
          click: () => { logger.setLevel('warn'); rebuildTrayMenu(); } },
        { label: 'error', type: 'radio', checked: logger.getLevel() === 'error',
          click: () => { logger.setLevel('error'); rebuildTrayMenu(); } },
      ],
    },
    {
      label: '打开日志文件夹',
      click: () => {
        try { shell.openPath(logger.getLogDir()); } catch {}
      },
    },
    {
      label: '清空日志',
      click: async () => {
        const { response } = await dialog.showMessageBox({
          type: 'question',
          buttons: ['取消', '清空'],
          defaultId: 0,
          cancelId: 0,
          title: '清空日志',
          message: '确定清空所有日志？',
        });
        if (response === 1) {
          logger.clearAll();
          logger.info('main', 'logs cleared');
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function applyAutoStart(enabled) {
  if (!app.isPackaged) return; // dev 模式不写注册表
  try {
    // 注意：不要传 args。打包后 setLoginItemSettings 默认指向应用 exe，
    // 传 ['--hidden'] 会在部分 Windows 版本上变成 "electron.exe --hidden" 而无法启动。
    app.setLoginItemSettings({ openAtLogin: !!enabled });
  } catch (e) {
    console.error('setLoginItemSettings 失败:', e.message);
    logger.warn('autoStart', `setLoginItemSettings failed: ${e.message}`);
  }
}


// ---------- IPC ----------
// 包装 ipcMain.handle：自动打入口日志 + 异常兜底
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...rest) => {
    logIpcStart(channel, rest);
    try {
      return await fn(event, ...rest);
    } catch (e) {
      logger.error('ipc', `${channel} threw: ${e.message}`, { stack: String(e.stack || '').slice(0, 800) });
      throw e;
    }
  });
}

function registerIpc() {
  handle('get-config', (_e, key) => {
    if (key) return store.get(key);
    return store.store;
  });

  handle('save-config', (_e, key, value) => {
    if (typeof key !== 'string') return false;
    store.set(key, value);
    return true;
  });

  // 位置保存：球在 transform 坐标里的位置
  handle('save-position', (_e, x, y) => {
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    const clamped = clampPosition({ x, y });
    lastPersistedPos = clamped;
    if (positionSaveTimer) { clearTimeout(positionSaveTimer); positionSaveTimer = null; }
    store.set('position', clamped);
    return clamped;
  });

  // renderer 同步球的当前 transform 位置给主进程（用于 ignore-mouse 决策）
  // 注意：这是 60fps 高频通道，不能走 logIpcStart，否则日志会被刷爆
  ipcMain.handle('update-ball-pos', (_e, x, y) => {
    if (typeof x === 'number' && typeof y === 'number') {
      // 取整，避免浮点坐标传给 Electron 原生方法（setPosition/BrowserWindow）导致 conversion failure
      currentBallPos = { x: Math.round(x), y: Math.round(y) };
      // 拖动结束/关闭时渲染端可能来不及发 save-position，这里兜底落盘
      if (!lastPersistedPos ||
          lastPersistedPos.x !== currentBallPos.x ||
          lastPersistedPos.y !== currentBallPos.y) {
        persistBallPosition(currentBallPos.x, currentBallPos.y);
      }
    }
    return true;
  });

  handle('show-card', () => false);

  handle('close-card', () => false);

  // 动画用：返回主显示器 workArea（去掉任务栏的可见区域，让弹跳中心和视觉中心对齐）
  handle('get-screen-info', () => {
    const w = screen.getPrimaryDisplay().workArea;
    return { width: w.width, height: w.height, x: w.x, y: w.y };
  });

  // OS 层鼠标穿透切换：renderer 根据光标位置动态调用
  // 渲染端打开/关闭菜单时上报外接矩形，扩大/恢复鼠标热区
  ipcMain.on('set-hit-region', (_e, rect) => {
    try {
      if (rect && [rect.x, rect.y, rect.w, rect.h].every((n) => typeof n === 'number' && isFinite(n))) {
        ballHitRegion = { x: rect.x, y: rect.y, w: Math.max(1, rect.w), h: Math.max(1, rect.h) };
        lastIgnoreState = null; // 强制下一轮重新判定
        logger.info('main.hitRegion', 'enabled ' + JSON.stringify(ballHitRegion));
      } else {
        ballHitRegion = null;
        lastIgnoreState = null;
        logger.info('main.hitRegion', 'disabled');
      }
    } catch (e) {
      logger.warn('main.hitRegion', 'bad rect: ' + e.message);
    }
  });

  handle('set-ignore-mouse', (_e, ignore) => {
    if (!ballWindow || ballWindow.isDestroyed()) return false;
    ballWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    return true;
  });

  // ---------- 模型管理（设置面板填写优先，空白回退 .env）----------

  handle('get-llm-status', async () => {
    const cfg = await resolveAiConfig();
    return {
      source: cfg.source,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      hasToken: !!cfg.token,
    };
  });

  handle('get-online-ai-config', () => {
    const saved = store.get('aiConfig') || {};
    const merged = onlineConfig.resolve(saved, { preferEnv: !app.isPackaged });
    const hasUserToken = !!(saved.token && String(saved.token).trim()) && merged.tokenSource === 'user';
    return {
      baseUrl: saved.baseUrl || merged.baseUrl || '',
      model: saved.model || merged.model || '',
      hasToken: !!merged.token,
      tokenHint: onlineConfig.maskToken(merged.token),
      fromEnv: merged.tokenSource === 'env',
      fromBundled: merged.tokenSource === 'bundled',
      tokenSource: merged.tokenSource || 'none',
    };
  });

  handle('save-online-ai-config', (_e, payload = {}) => {
    const prev = store.get('aiConfig') || {};
    const nextToken = typeof payload.token === 'string' ? payload.token.trim() : '';
    const next = {
      baseUrl: typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : (prev.baseUrl || ''),
      model: typeof payload.model === 'string' ? payload.model.trim() : (prev.model || ''),
      token: nextToken || prev.token || '',
    };
    store.set('aiConfig', next);
    logger.info('aiConfig', `saved model=${next.model} baseUrl=${next.baseUrl} hasToken=${!!next.token}`);
    return {
      ok: true,
      tokenHint: onlineConfig.maskToken(onlineConfig.resolve(next, { preferEnv: !app.isPackaged }).token),
      tokenSource: onlineConfig.resolve(next, { preferEnv: !app.isPackaged }).tokenSource,
    };
  });

  // 清除设置面板里保存的 Key，回退到 .env（如果 .env 里也有）
  handle('clear-online-ai-token', () => {
    const prev = store.get('aiConfig') || {};
    store.set('aiConfig', { baseUrl: prev.baseUrl || '', model: prev.model || '', token: '' });
    logger.info('aiConfig', 'saved token cleared');
    const merged = onlineConfig.resolve(store.get('aiConfig'));
    return { ok: true, hasToken: !!merged.token, fromEnv: !merged.token || !!onlineConfig.token };
  });

  handle('test-online-ai', async () => {
    const cfg = await resolveAiConfig();
    return ai.testConnection({ baseUrl: cfg.baseUrl, token: cfg.token, model: cfg.model });
  });

  // 列出 Ollama 已装模型
  handle('get-local-models', async () => {
    return await localLLM.listModels();
  });

  // 设置本地模型名（空 = 清除，回到线上）
  handle('set-local-model', (_e, name) => {
    const v = typeof name === 'string' ? name.trim() : '';
    store.set('localModel', v);
    logger.info('localModel', `set to "${v}"`);
    return true;
  });

  // 下载本地模型（Ollama pull）
  handle('pull-local-model', async (_e, name) => {
    const result = await localLLM.pullModel(name);
    logger.info('localModel', `pull "${name}" ok=${result.ok}`);
    return result;
  });


  handle('get-persona', () => (PERSONAS[store.get('persona')] ? store.get('persona') : 'cat'));

  handle('set-persona', (_e, name) => {
    const next = PERSONAS[name] ? name : 'cat';
    store.set('persona', next);
    logger.info('persona', 'set to ' + next);
    broadcastPersona(next);
    rebuildTrayMenu();
    return next;
  });

  handle('accept-consent', () => {
    const wasFirstRun = needsConsent();
    store.set('consentVersion', AGREEMENT_VERSION);
    logger.info('consent', 'version=' + AGREEMENT_VERSION);
    if (wasFirstRun) app.emit('consent-accepted');
    if (consentWindow && !consentWindow.isDestroyed()) {
      // 允许正常关闭
      consentWindow.removeAllListeners('close');
      consentWindow.close();
    }
    return true;
  });

  handle('quit-app', () => {
    isQuitting = true;
    app.quit();
    return true;
  });

  handle('open-legal', (_e, key) => {
    createLegalWindow(key);
    return true;
  });

  handle('open-settings', () => {
    createSettingsWindow();
    return true;
  });

  // 设置面板的「预览动画」：让球抖一下，确认动画开关生效
  handle('preview-ball-anim', () => {
    if (!ballWindow || ballWindow.isDestroyed()) createBallWindow();
    ballWindow.show();
    ballWindow.focus();
    // 等球窗口加载完成再发，避免首次预览时事件丢失
    if (ballWindow.webContents.isLoading()) {
      ballWindow.webContents.once('did-finish-load', () => {
        ballWindow.webContents.send('preview-ball-anim');
      });
    } else {
      ballWindow.webContents.send('preview-ball-anim');
    }
    logger.info('main.anim', 'preview requested');
    return true;
  });

  // ---------- AI 浮窗 ----------
  handle('open-ai-input', () => {
    openAiInputWindow();
    return true;
  });

  handle('reset-agent-chat', () => {
    clearAgentChat();
    logger.info('agent.reset', 'history cleared');
    return { ok: true, messages: [] };
  });

  handle('close-ai-input', () => {
    if (aiInputWindow && !aiInputWindow.isDestroyed()) aiInputWindow.hide();
    return true;
  });

  // 用户在浮窗提交提问 → 调模型 → 返回文本（浮窗内直接显示）
  handle('ai-interpret-ask', async (_e, payload = {}) => {
    const query = (payload.query || '').trim();
    if (!query) return { ok: false, error: 'EMPTY_QUERY' };

    const aiCfg = await resolveAiConfig();
    if (!aiCfg.token) {
      if (aiInputWindow && !aiInputWindow.isDestroyed()) {
        aiInputWindow.webContents.send('ai-input-error', {
          kind: 'NO_TOKEN',
          text: '请先在设置中配置 API Token',
        });
        setTimeout(() => createSettingsWindow(), 600);
      }
      return { ok: false, error: 'NO_TOKEN' };
    }

    const ctx = { installId: store.get('installId') };

    const sendProgress = (info) => {
      if (aiInputWindow && !aiInputWindow.isDestroyed()) {
        aiInputWindow.webContents.send('ai-agent-progress', info);
      }
    };

    try {
      const { result, usedFallback } = await withAiFallback((cfg) => agent.runAgent({
        history: agentHistory,
        userQuery: query,
        aiConfig: cfg,
        ctx,
        callLLM: ai.callLLM,
        onProgress: sendProgress,
      }));
      agentHistory = result.history || [];
      saveAgentChat();
      logger.info('agent.chat', `tokens=${result.usage.total_tokens || '?'} fallback=${usedFallback}`);
      return {
        ok: true,
        text: result.text,
        notice: usedFallback ? aiFallbackNotice : '',
      };
    } catch (e) {
      const msg = String(e.message || e);
      logger.error('agent.chat', msg, { query: query.slice(0, 50) });
      if (aiInputWindow && !aiInputWindow.isDestroyed()) {
        aiInputWindow.webContents.send('ai-input-error', {
          kind: msg,
          text: friendlyError(msg),
        });
      }
      return { ok: false, error: msg };
    }
  });
}

function sendAiInputFocus(win) {
  if (!win || win.isDestroyed()) return;
  const payload = { messages: agent.publicHistory(agentHistory) };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send('ai-input-focus', payload);
    });
  } else {
    win.webContents.send('ai-input-focus', payload);
  }
}

// IPC 入口日志 helper：自动捕获 ipc channel 名 + 简单参数摘要
function logIpcStart(channel, args) {
  try {
    const summary = args.map((a) => {
      if (a == null) return String(a);
      if (typeof a === 'string') return a.length > 40 ? a.slice(0, 40) + '...' : a;
      if (typeof a === 'number') return String(a);
      if (typeof a === 'boolean') return String(a);
      if (Array.isArray(a)) return `[${a.length}]`;
      return '{...}';
    });
    logger.info('ipc', `${channel} args=${summary.join(',')}`);
  } catch {}
}

function friendlyError(code) {
  return {
    NO_TOKEN: '尚未配置 Token，请先在设置中填入',
    AUTH_FAILED: 'Token 无效或已过期，请检查',
    RATE_LIMITED: '调用太频繁，请稍后再试',
    TIMEOUT: '网络有点慢，稍后再试',
    NETWORK: '网络好像不太给力',
    EMPTY_QUERY: '问题不能为空',
    EMPTY_RESPONSE: '模型没有返回内容',
    AGENT_MAX_STEPS: '这轮调用太长，请换个说法再问',
    INSUFFICIENT_BALANCE: 'AI 额度已用尽，请充值或在设置里换用自己的 Key',
    UPSTREAM_ERROR: '模型服务返回错误，稍后再试',
    BAD_JSON: '模型返回格式异常，稍后重试',
    NO_MESSAGES: '请求内容为空',
  }[code] || ('请求失败：' + code);
}

// ---------- 生命周期 ----------
app.on('second-instance', () => {
  logger.info('main.lifecycle', 'second-instance launched');
  if (!ballWindow || ballWindow.isDestroyed()) createBallWindow();
  if (ballWindow.isMinimized()) ballWindow.restore();
  ballWindow.show();
  ballWindow.focus();
});

app.whenReady().then(() => {
  logger.info('main', 'app ready', {
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    packaged: app.isPackaged,
  });
  // 启动诊断：确认 AI 配置来源（user / env / bundled / none），不记录 Key 本身
  try {
    const cfgNow = onlineConfig.resolve(store.get('aiConfig'), { preferEnv: !app.isPackaged });
    logger.info('main.aiConfig', 'resolved', {
      source: cfgNow.tokenSource,
      hasToken: !!cfgNow.token,
      model: cfgNow.model,
      resourcesPath: process.resourcesPath || '',
    });
  } catch (e) {
    logger.warn('main.aiConfig', 'resolve failed: ' + e.message);
  }
  registerIpc();
  registerLogIpc();

  const boot = () => {
    createBallWindow();
    registerShortcut();
    applyAutoStart(store.get('autoStart') === true);
    startCursorPolling();
    startWatcher();
    setTimeout(() => {
      selfCheck.runSelfCheck({
        logWatcher,
        onlineConfig,
        getOnlineToken: () => onlineConfig.resolve(store.get('aiConfig'), { preferEnv: !app.isPackaged }).token,
        localLLM,
        tray,
        ballWindow,
        globalShortcut,
      }).catch((e) => logger.warn('selfCheck', 'run failed: ' + e.message));
    }, 5000);
  };

  // 首次启动（或协议版本升级）必须先同意用户协议/隐私政策
  if (needsConsent()) {
    logger.info('consent', 'required (version=' + AGREEMENT_VERSION + ')');
    createConsentWindow();
    // 托盘仍创建，方便用户从菜单退出
    createTray();
    // 同意后立即进入正常启动流程
    app.once('consent-accepted', () => {
      logger.info('consent', 'accepted, starting app');
      boot();
    });
    return;
  }
  boot();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createBallWindow();
  });
});

// 全部窗口关闭时不退出（托盘应用）
app.on('window-all-closed', () => {
  logger.info('main.lifecycle', 'window-all-closed');
  // 托盘应用：保持进程存活
});

app.on('before-quit', () => {
  logger.info('main.lifecycle', 'before-quit');
  isQuitting = true;
  // 把待写入的位置立即落盘
  if (positionSaveTimer) { clearTimeout(positionSaveTimer); positionSaveTimer = null; }
  if (lastPersistedPos) {
    store.set('position', lastPersistedPos);
  } else if (ballWindow && !ballWindow.isDestroyed()) {
    const [x, y] = ballWindow.getPosition();
    store.set('position', clampPosition({ x, y }));
  }
});

app.on('will-quit', () => {
  logger.info('main.lifecycle', 'will-quit');
  try { globalShortcut.unregisterAll(); } catch {}
  if (cursorPollTimer) clearInterval(cursorPollTimer);
});

// ---------- 主进程轮询光标位置，独立决策 ignore-mouse ----------
// 不依赖 renderer 的 mousemove 事件（避免 forwarded 事件丢/延迟问题）
let cursorPollTimer = null;
function startCursorPolling() {
  if (cursorPollTimer) return;
  logger.info('main.cursorPolling', 'started');
  cursorPollTimer = setInterval(() => {
    if (!ballWindow || ballWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = ballWindow.getBounds();
    // 球屏幕坐标 = 窗口原点 + transform 坐标
    const ballLeft   = bounds.x + currentBallPos.x - BALL_HALO;
    const ballRight  = bounds.x + currentBallPos.x + BALL_SIZE + BALL_HALO;
    const ballTop    = bounds.y + currentBallPos.y - BALL_HALO;
    const ballBottom = bounds.y + currentBallPos.y + BALL_SIZE + BALL_HALO;
    let isOver = cursor.x >= ballLeft && cursor.x <= ballRight &&
                 cursor.y >= ballTop  && cursor.y <= ballBottom;
    // 菜单打开：只要光标在「猫 + 面板」矩形内就继续接收鼠标，否则面板没法点击
    if (!isOver && ballHitRegion) {
      // 渲染端上报的是窗口内坐标，换算成屏幕坐标
      const r = ballHitRegion;
      const rx = bounds.x + r.x, ry = bounds.y + r.y;
      isOver = cursor.x >= rx && cursor.x <= rx + r.w &&
               cursor.y >= ry && cursor.y <= ry + r.h;
    }

    const shouldIgnore = !isOver;
    if (lastIgnoreState !== shouldIgnore) {
      lastIgnoreState = shouldIgnore;
      // 不带 forward：cursor 不在球上时事件完全穿透，命中球的瞬间再收回
      ballWindow.setIgnoreMouseEvents(shouldIgnore);
    }
  }, 80);
}

// ---------- 渲染端日志 IPC ----------
function registerLogIpc() {
  ipcMain.on('log-info',  (_e, scope, msg, meta) => logger.info(scope, msg, meta || {}));
  ipcMain.on('log-warn',  (_e, scope, msg, meta) => logger.warn(scope, msg, meta || {}));
  ipcMain.on('log-error', (_e, scope, msg, meta) => logger.error(scope, msg, meta || {}));
  ipcMain.on('log-critical', (_e, scope, msg, meta) => logger.critical(scope, msg, meta || {}));
}

// ---------- LogWatcher + AI 诊断 ----------
let logWatcher = null;
async function runAiDiagnose(ctx) {
  const aiCfg = await resolveAiConfig();
  if (!aiCfg.token) {
    logger.warn('watcher.diagnose', 'NO_TOKEN, skip AI', { category: ctx.category });
    return null;
  }
  try {
    const result = await ai.diagnose({
      line: ctx.line,
      recentLines: ctx.recentLines,
      meta: ctx.meta,
      ctx: { level: ctx.level, pattern: ctx.pattern, hint: ctx.hint },
      aiConfig: aiCfg,
    });
    logger.info('watcher.diagnose',
      `${result.rootCause} | 建议: ${result.fix}`,
      { confidence: result.confidence, model: result.model, category: ctx.category },
    );
    return result;
  } catch (e) {
    const msg = String(e.message || e);
    logger.warn('watcher.diagnose', `失败: ${msg}`, { category: ctx.category });
    return null;
  }
}

function notifyCritical(diagnosis, ctx) {
  if (!Notification.isSupported()) return;
  const body = diagnosis
    ? `${diagnosis.rootCause}\n建议: ${diagnosis.fix}`
    : `${ctx.hint || ctx.pattern || '检测到异常'}\n请查看日志了解详情`;
  try {
    const n = new Notification({
      title: '桌面陪伴 · 检测到异常',
      body: body.slice(0, 240),
      urgency: 'critical',
    });
    n.on('click', () => {
      try { shell.openPath(logger.getLogDir()); } catch {}
    });
    n.show();
  } catch (e) {
    logger.warn('notify', 'show failed', { error: e.message });
  }
}

function startWatcher() {
  if (logWatcher) return;
  logWatcher = new LogWatcher();
  logWatcher.start({
    onDiagnose: async (ctx) => {
      const result = await runAiDiagnose(ctx);
      // 把诊断结果挂到 ctx，供 onNotify 用
      ctx._diagnosis = result;
    },
    onNotify: (ctx) => {
      // 等 100ms 让 onDiagnose 先跑（Promise 微任务）
      setTimeout(() => notifyCritical(ctx._diagnosis, ctx), 100);
    },
  });
}

// ---------- 全局快捷键 ----------
function registerShortcut() {
  try {
    const ok = globalShortcut.register('CommandOrControl+Alt+F', () => {
      if (!ballWindow || ballWindow.isDestroyed()) createBallWindow();
      ballWindow.show();
      ballWindow.focus();
      // 唤出 AI 对话
      openAiInputWindow();
    });
    if (!ok) {
      logger.warn('shortcut', 'Ctrl+Alt+F 已被其他应用占用，全局快捷键不可用');
    } else {
      logger.info('shortcut', 'Ctrl+Alt+F registered');
    }
  } catch (e) {
    console.error('globalShortcut 注册失败:', e.message);
    logger.warn('shortcut', `register failed: ${e.message}`);
  }
}
