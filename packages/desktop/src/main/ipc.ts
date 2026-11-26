// ipc.ts - IPC 注册（按域拆分；入参用 zod 校验）

import fs from 'node:fs'
import path from 'node:path'
import { app, dialog, ipcMain, screen } from 'electron'
import { z } from 'zod'
import * as ai from './services/ai'
import * as localLLM from './services/localLLM'
import * as onlineConfig from './services/onlineConfig'
import { logger } from './services/logger'
import { handleAsk, resetChat } from './chat'
import { extractMemories, bumpInteraction, ensureDailyDiary, ensureAbsenceDiary } from './remember'
import * as absence from '../core/absence'
import * as occasions from './occasions'
import * as dailyLog from './dailyLog'
import * as mail from './mail'
import { createMailWindow } from './mailWindow'
import { eraseMargin, writeMargin } from './margin'
import * as weather from './weatherService'
import * as memory from '../core/memory'
import * as notebook from '../core/notebook'
import * as backup from '../core/backup'
import * as mailbox from '../core/mailbox'
import {
  store,
  resolveAiConfig,
  resolveOnline,
  getMemories,
  setMemories,
  getNotebook,
  setNotebook,
  isMemoryEnabled,
} from './store'
import { state, windows } from './state'
import {
  AGREEMENT_VERSION,
  clampPosition,
  createBallWindow,
  createLegalWindow,
  createSettingsWindow,
  createNotebookWindow,
  needsConsent,
  openAiInputWindow,
  persistBallPosition,
} from './windows'
import { PERSONAS, broadcastPersona, rebuildTrayMenu, resetBallPosition } from './tray'
import { CH, EV } from '../shared/channels'
import { configKeySchema, debugAwayMsSchema, localModelSchema, marginSchema, memoryIdSchema, occasionConsumeSchema, occasionsIdSchema, petNameSchema, rectSchema } from '../shared/ipc'
import type { AiConfig, Persona } from '../shared/types'

type WeatherStatusPlace = { city: string; label: string; latitude: number; longitude: number }

// 包装 ipcMain.handle：打入口日志 + 异常兜底
function handle<T>(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (event, ...args: any[]) => {
    logIpcStart(channel, args)
    try {
      return await fn(event, ...args)
    } catch (e) {
      logger.error('ipc', `${channel} threw: ${(e as Error).message}`, {
        stack: String((e as Error).stack || '').slice(0, 800),
      })
      throw e
    }
  })
}

// 高频通道：只做最小校验，不写日志
function handleFast<T>(channel: string, schema: z.ZodTypeAny, fn: (...args: any[]) => T): void {
  ipcMain.handle(channel, async (_e, ...args: any[]) => {
    const parsed = schema.safeParse(args)
    if (!parsed.success) {
      logger.warn('ipc.fast', `${channel} rejected args`)
      return false
    }
    return fn(...(parsed.data as any[]))
  })
}

function logIpcStart(channel: string, args: unknown[]): void {
  try {
    const summary = args.map((a) => {
      if (a == null) return String(a)
      if (typeof a === 'string') return a.length > 40 ? a.slice(0, 40) + '...' : a
      if (typeof a === 'number' || typeof a === 'boolean') return String(a)
      if (Array.isArray(a)) return `[${a.length}]`
      return '{...}'
    })
    logger.info('ipc', `${channel} args=${summary.join(',')}`)
  } catch {
    /* ignore */
  }
}

/** 许愿瓶状态视图：设置页与纸条窗口共用 */
function bottleStatusView() {
  const s = mail.bottleSettings()
  const thrown = store.get('bottleThrownToday')
  const now = new Date()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const today = now.getFullYear() + '-' + m + '-' + d
  return {
    enabled: mail.isBottleEnabled(),
    endpoint: s.endpoint,
    canThrow: true,
    thrownToday: thrown && thrown.day === today ? thrown.n : 0,
    dailyLimit: mailbox.DAILY_BOTTLE_LIMIT,
  }
}

export function registerIpc(): void {
  // ---------- 配置 ----------
  handle(CH.getConfig, (_e, key: unknown) => {
    const parsed = z.union([configKeySchema, z.literal('')]).safeParse(key)
    if (!parsed.success) return undefined
    return parsed.data ? store.get(parsed.data as any) : store.store
  })

  handle(CH.saveConfig, (_e, key: unknown, value: unknown) => {
    const parsed = configKeySchema.safeParse(key)
    if (!parsed.success) return false
    store.set(parsed.data, value as any)
    if (windows.ball && !windows.ball.isDestroyed()) {
      windows.ball.webContents.send(EV.configChanged, parsed.data, value)
    }
    return true
  })

  // ---------- 位置与热区 ----------
  handle(CH.savePosition, (_e, x: unknown, y: unknown) => {
    if (typeof x !== 'number' || typeof y !== 'number') return null
    const clamped = clampPosition({ x, y })
    state.lastPersistedPos = clamped
    if (state.positionSaveTimer) {
      clearTimeout(state.positionSaveTimer)
      state.positionSaveTimer = null
    }
    store.set('position', clamped)
    return clamped
  })

  // 60fps 高频通道：不写日志；顺带兜底落盘
  handleFast(CH.updateBallPos, z.tuple([z.number().finite(), z.number().finite()]), (x: number, y: number) => {
    state.currentBallPos = { x: Math.round(x), y: Math.round(y) }
    const p = state.lastPersistedPos
    if (!p || p.x !== state.currentBallPos.x || p.y !== state.currentBallPos.y) {
      persistBallPosition(state.currentBallPos.x, state.currentBallPos.y)
    }
    return true
  })

  handle(CH.getScreenInfo, () => {
    const w = screen.getPrimaryDisplay().workArea
    return { width: w.width, height: w.height, x: w.x, y: w.y }
  })

  // 渲染端打开/关闭菜单时上报外接矩形
  ipcMain.on(CH.setHitRegion, (_e, rect: unknown) => {
    const parsed = rectSchema.safeParse(rect)
    if (!parsed.success) {
      logger.warn('main.hitRegion', 'bad rect')
      state.ballHitRegion = null
      state.lastIgnoreState = null
      return
    }
    if (parsed.data) {
      const r = parsed.data
      state.ballHitRegion = { x: r.x, y: r.y, w: Math.max(1, r.w), h: Math.max(1, r.h) }
      state.lastIgnoreState = null
      logger.info('main.hitRegion', 'enabled ' + JSON.stringify(state.ballHitRegion))
    } else {
      state.ballHitRegion = null
      state.lastIgnoreState = null
      logger.info('main.hitRegion', 'disabled')
    }
  })

  handle(CH.setIgnoreMouse, (_e, ignore: unknown) => {
    if (!windows.ball || windows.ball.isDestroyed()) return false
    windows.ball.setIgnoreMouseEvents(!!ignore, { forward: true })
    return true
  })

  // ---------- 形象 ----------
  handle(CH.getPersona, () => {
    const p = store.get('persona')
    return PERSONAS[p] ? p : 'cat'
  })

  handle(CH.setPersona, (_e, name: unknown) => {
    const next: Persona = PERSONAS[name as Persona] ? (name as Persona) : 'cat'
    store.set('persona', next)
    logger.info('persona', 'set to ' + next)
    broadcastPersona(next)
    rebuildTrayMenu()
    return next
  })

  handle(CH.setPetName, (_e, name: unknown) => {
    const parsed = petNameSchema.safeParse(name)
    const next = parsed.success ? parsed.data : ''
    const pet = store.get('pet') || { name: '', lastInteractAt: 0, lastGreetDate: '' }
    store.set('pet', { ...pet, name: next })
    logger.info('pet', 'name set ' + (next || '(empty)'))
    return next
  })

  // ---------- 模型 ----------
  handle(CH.getLlmStatus, async () => {
    const cfg = await resolveAiConfig()
    return { source: cfg.source, model: cfg.model, baseUrl: cfg.baseUrl, hasToken: !!cfg.token }
  })

  handle(CH.getOnlineAiConfig, () => {
    const saved = store.get('aiConfig') || ({} as AiConfig)
    const merged = resolveOnline(saved)
    return {
      baseUrl: saved.baseUrl || merged.baseUrl || '',
      model: saved.model || merged.model || '',
      hasToken: !!merged.token,
      tokenHint: onlineConfig.maskToken(merged.token),
      fromEnv: merged.tokenSource === 'env',
      fromBundled: merged.tokenSource === 'bundled',
      tokenSource: merged.tokenSource || 'none',
    }
  })

  handle(CH.saveOnlineAiConfig, (_e, payload: unknown) => {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Partial<AiConfig>
    const prev = store.get('aiConfig') || ({} as AiConfig)
    const nextToken = typeof p.token === 'string' ? p.token.trim() : ''
    const next: AiConfig = {
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.trim() : prev.baseUrl || '',
      model: typeof p.model === 'string' ? p.model.trim() : prev.model || '',
      token: nextToken || prev.token || '',
    }
    store.set('aiConfig', next)
    logger.info('aiConfig', `saved model=${next.model} baseUrl=${next.baseUrl} hasToken=${!!next.token}`)
    const resolved = resolveOnline(next)
    return { ok: true, tokenHint: onlineConfig.maskToken(resolved.token), tokenSource: resolved.tokenSource }
  })

  handle(CH.clearOnlineAiToken, () => {
    const prev = store.get('aiConfig') || ({} as AiConfig)
    store.set('aiConfig', { baseUrl: prev.baseUrl || '', model: prev.model || '', token: '' })
    logger.info('aiConfig', 'saved token cleared')
    const merged = resolveOnline(store.get('aiConfig'))
    return { ok: true, hasToken: !!merged.token, fromEnv: !merged.token }
  })

  handle(CH.testOnlineAi, async () => {
    const cfg = await resolveAiConfig()
    return ai.testConnection({ baseUrl: cfg.baseUrl, token: cfg.token, model: cfg.model })
  })

  handle(CH.getLocalModels, async () => localLLM.listModels())

  handle(CH.setLocalModel, (_e, name: unknown) => {
    const parsed = localModelSchema.safeParse(name)
    const v = parsed.success ? parsed.data.trim() : ''
    store.set('localModel', v)
    logger.info('localModel', `set to "${v}"`)
    return true
  })

  handle(CH.pullLocalModel, async (_e, name: unknown) => {
    const parsed = localModelSchema.safeParse(name)
    const result = await localLLM.pullModel(parsed.success ? parsed.data : '')
    logger.info('localModel', `pull ok=${result.ok}`)
    return result
  })

  // ---------- 系统与窗口 ----------
  handle(CH.acceptConsent, () => {
    const wasFirstRun = needsConsent()
    store.set('consentVersion', AGREEMENT_VERSION)
    logger.info('consent', 'version=' + AGREEMENT_VERSION)
    if (wasFirstRun) app.emit('consent-accepted')
    if (windows.consent && !windows.consent.isDestroyed()) {
      windows.consent.removeAllListeners('close')
      windows.consent.close()
    }
    return true
  })

  // ---------- 猫的笔记本 / 记忆 / 备份（S2） ----------
  handle(CH.openNotebook, () => {
    ensureDailyDiary()
    createNotebookWindow()
    return true
  })

  handle(CH.getNotebookView, () => ({
    entries: notebook.recentEntries(getNotebook(), 60).map((e) => ({
      date: e.date,
      lines: e.lines,
      ...(e.margin ? { margin: { text: e.margin.text, createdAt: e.margin.createdAt } } : {}),
    })),
  }))

  // P2 页边一句话：写 / 抹。没有「读取单条」通道——页边随笔记本一起读。
  handle(CH.writeNotebookMargin, (_e, payload: unknown) => {
    const p = marginSchema.safeParse(payload)
    if (!p.success) return null
    const entry = writeMargin(p.data.date, p.data.text)
    if (!entry) return null
    return {
      date: entry.date,
      lines: entry.lines,
      ...(entry.margin ? { margin: { text: entry.margin.text, createdAt: entry.margin.createdAt } } : {}),
    }
  })

  handle(CH.eraseNotebookMargin, (_e, date: unknown) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
    return eraseMargin(date)
  })

  handle(CH.exportNotebookMarkdown, async () => {
    const md = notebook.toMarkdown(getNotebook())
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出笔记本',
      defaultPath: '猫的笔记本-' + new Date().toISOString().slice(0, 10) + '.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    fs.writeFileSync(filePath, md, 'utf8')
    logger.info('notebook.export', 'markdown saved')
    return { ok: true, path: filePath }
  })

  // P2：导出内容本身（不弹对话框）。让「页边话确实进了导出」变成可验证的事实，
  // 而不是只能靠人点开文件看。渲染端不用它，只给测试与调试用。
  handle(CH.notebookMarkdownPreview, () => notebook.toMarkdown(getNotebook()))

  handle(CH.getMemories, () => {
    const list = getMemories().slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return { enabled: isMemoryEnabled(), max: memory.MAX_MEMORIES, memories: list }
  })

  handle(CH.deleteMemory, (_e, id: unknown) => {
    const parsed = memoryIdSchema.safeParse(id)
    if (parsed.success) {
      setMemories(memory.removeMemory(getMemories(), parsed.data))
      logger.info('memory.delete', 'one removed')
      ensureDailyDiary()
    }
    const list = getMemories().slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return { enabled: isMemoryEnabled(), max: memory.MAX_MEMORIES, memories: list }
  })

  handle(CH.clearMemories, () => {
    setMemories([])
    logger.info('memory.clear', 'all removed')
    return { enabled: isMemoryEnabled(), max: memory.MAX_MEMORIES, memories: [] }
  })

  handle(CH.setMemoryEnabled, (_e, enabled: unknown) => {
    store.set('memoryEnabled', enabled !== false)
    logger.info('memory.enabled', String(enabled !== false))
    return true
  })

  // ---------- 事件记忆（P1.5）----------
  const occasionView = (o: ReturnType<typeof occasions.listOccasions>[number]) => ({
    id: o.id,
    text: o.text,
    kind: o.kind,
    date: o.date,
    status: o.status,
    certainty: o.certainty,
  })

  handle(CH.occasionsList, () => ({
    enabled: store.get('occasionsEnabled') !== false,
    max: 10,
    occasions: occasions.listOccasions().map(occasionView),
  }))

  handle(CH.occasionsDismiss, (_e, id: unknown) => {
    const parsed = occasionsIdSchema.safeParse(id)
    if (!parsed.success) return false
    return occasions.dismiss(parsed.data)
  })

  handle(CH.occasionsSetEnabled, (_e, enabled: unknown) => {
    occasions.setEnabled(enabled !== false)
    return {
      enabled: store.get('occasionsEnabled') !== false,
      max: 10,
      occasions: occasions.listOccasions().map(occasionView),
    }
  })

  handle(CH.occasionPeek, () => {
    const p = occasions.peekBeat()
    if (!p) return null
    return { beat: p.beat, line: p.line, occasion: occasionView(p.occasion) }
  })

  handle(CH.occasionConsume, (_e, payload: unknown) => {
    const p = occasionConsumeSchema.safeParse(payload)
    if (!p.success) return false
    const list = occasions.listOccasions()
    const target = list.find((o) => o.id === p.data.id)
    if (!target) return false
    // 复用 core 的 markBeat：只标记，不重新推演状态
    occasions.consumeBeat({ beat: p.data.beat, occasion: target, line: '' })
    return true
  })

  // 测试用：与聊天里说一句话走同一条抽取路径
  handle(CH.occasionDebugRemember, (_e, message: unknown) => {
    const text = z.string().max(500).parse(message)
    return occasions.rememberFromMessage(text).map(occasionView)
  })

  // ---------- 日常记事（M7）----------
  const dailyView = (n: ReturnType<typeof dailyLog.todayNotes>[number]) => ({
    id: n.id,
    text: n.text,
    day: n.day,
    at: n.at,
  })

  handle(CH.dailyRecapPeek, () => dailyLog.peekRecap())
  handle(CH.dailyRecapMark, () => {
    dailyLog.markRecapped()
    return true
  })
  handle(CH.dailyNotesList, () => ({
    days: dailyLog.recentNotes().map((d) => ({ day: d.day, notes: d.notes.map(dailyView) })),
  }))
  handle(CH.dailyNoteRemove, (_e, id: unknown) => {
    const parsed = occasionsIdSchema.safeParse(id)
    if (!parsed.success) return false
    return dailyLog.removeNote(parsed.data)
  })
  // 测试用：与聊天里说一句话走同一条抽取路径
  handle(CH.dailyDebugRemember, (_e, message: unknown) => {
    const text = z.string().max(500).parse(message)
    return dailyLog.rememberDaily(text)
  })

  handle(CH.exportBackup, async () => {
    const payload = backup.exportBackup({
      petName: store.get('pet')?.name || '',
      memories: getMemories(),
      notebook: getNotebook(),
      agentChat: { messages: store.get('agentChat')?.messages || [], updatedAt: store.get('agentChat')?.updatedAt || 0 },
    })
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出全部数据',
      defaultPath: 'companion-ball-backup-' + new Date().toISOString().slice(0, 10) + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
    logger.info('backup.export', 'saved')
    return { ok: true, path: filePath }
  })

  handle(CH.importBackup, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入数据备份',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePaths.length) return { ok: false, canceled: true }
    const raw = fs.readFileSync(filePaths[0]!, 'utf8')
    const parsed = backup.parseBackup(raw)
    if (!parsed.ok || !parsed.data) return { ok: false, error: parsed.error || '备份无法解析' }
    const data = parsed.data
    const pet = store.get('pet') || { name: '', lastInteractAt: 0, lastGreetDate: '' }
    store.set('pet', { ...pet, name: data.petName || pet.name })
    setMemories(data.memories)
    setNotebook(data.notebook)
    if (data.agentChat) {
      store.set('agentChat', { messages: data.agentChat.messages, updatedAt: data.agentChat.updatedAt })
    }
    logger.info('backup.import', `memories=${data.memories.length} diary=${data.notebook.entries.length}`)
    return { ok: true, stats: { memories: data.memories.length, diaryEntries: data.notebook.entries.length } }
  })

  // ---------- 许愿瓶（S3） ----------
  handle(CH.bottleStatus, () => bottleStatusView())

  handle(CH.bottleToggle, (_e, payload: unknown) => {
    const p = (payload && typeof payload === 'object' ? payload : {}) as { enabled?: boolean; endpoint?: string }
    const prev = mail.bottleSettings()
    const next = {
      ...prev,
      enabled: p.enabled === true,
      endpoint: typeof p.endpoint === 'string' ? p.endpoint.trim() : prev.endpoint,
    }
    store.set('bottle', next)
    logger.info('bottle.toggle', `enabled=${next.enabled} endpoint=${next.endpoint ? 'set' : 'empty'}`)
    return bottleStatusView()
  })

  handle(CH.bottleThrow, async (_e, body: unknown, requestPublic: unknown) => {
    return mail.throwBottle(String(body ?? ''), requestPublic === true)
  })

  handle(CH.bottlePick, async (_e, force: unknown) => {
    const r = await mail.catGoesOut(force === true)
    if (r.ok && r.data) mail.noteBottleInNotebook('picked', r.data.body, r.data.alias)
    return r
  })

  handle(CH.bottleReply, async (_e, bottleId: unknown, body: unknown) => {
    const r = await mail.replyBottle(String(bottleId ?? ''), String(body ?? ''))
    return r
  })

  // 收信：**只读**。反复打开列表不该把同一封回信写进日记好几遍。
  handle(CH.bottleInbox, async () => mail.peekInbox())

  // 用户点「收下」时才写进当天日记（按内容去重，重复点不会重复写）
  handle(CH.bottleInboxKeep, async (_e, replies: unknown) => {
    if (!Array.isArray(replies)) return 0
    const list = replies.filter(
      (r): r is { bottleId: string; bottleBody: string; replyBody: string; replyAlias: string; createdAt: number } =>
        !!r && typeof r === 'object' && typeof (r as { replyBody?: unknown }).replyBody === 'string',
    )
    return mail.keepReplies(list)
  })

  handle(CH.bottleReport, async (_e, target: unknown, reason: unknown) => {
    const t = (target && typeof target === 'object' ? target : {}) as { bottleId?: string; replyId?: string }
    const rr = ['spam', 'abuse', 'other'].includes(String(reason)) ? (String(reason) as 'spam' | 'abuse' | 'other') : 'other'
    return mail.report(t, rr)
  })

  handle(CH.bottlePatrolNow, async () => {
    if (!mail.isBottleEnabled()) return { ok: false, error: 'SERVICE_PAUSED', errorText: '许愿瓶还没开启' }
    const r = await mail.patrolOnce()
    if (r.found) {
      if (windows.ball && !windows.ball.isDestroyed()) {
        windows.ball.webContents.send('bottle-picked', { alias: r.alias })
      }
      return { ok: true, data: { alias: r.alias, body: r.body } }
    }
    return { ok: true, data: null, errorText: r.errorText }
  })

  // ---------- 天气氛围（S4，默认关闭） ----------
  handle(CH.weatherStatus, () => {
    const cfg = weather.weatherSettings()
    const snap = weather.currentWeatherSnapshot()
    return {
      enabled: cfg.enabled,
      place: cfg.place,
      current: snap ? { kind: snap.kind, isDay: snap.isDay } : null,
    }
  })

  handle(CH.weatherLookup, async (_e, city: unknown) => {
    const place = await weather.lookupCity(String(city ?? ''))
    return place ? { ok: true, place } : { ok: false, error: 'NOT_FOUND' }
  })

  handle(CH.weatherSet, (_e, payload: unknown) => {
    const p = (payload && typeof payload === 'object' ? payload : {}) as {
      enabled?: boolean
      place?: WeatherStatusPlace | null
    }
    weather.setWeatherSettings({ enabled: p.enabled === true, place: p.place === undefined ? undefined : p.place })
    weather.restartWeatherWatcher()
    const cfg = weather.weatherSettings()
    const snap = weather.currentWeatherSnapshot()
    logger.info('weather.set', `enabled=${cfg.enabled}`)
    return {
      enabled: cfg.enabled,
      place: cfg.place,
      current: snap ? { kind: snap.kind, isDay: snap.isDay } : null,
    }
  })

  // 测试用：与托盘共用 resetBallPosition，保证验证的是真实路径
  handle(CH.debugResetBall, () => {
    resetBallPosition('debug')
    return true
  })

  // 测试用：模拟一段缺席，把生成的日记行返回（供 e2e 断言）
  handle(CH.debugAbsenceDiary, (_e, awayMs: unknown) => {
    const ms = debugAwayMsSchema.parse(awayMs)
    const now = Date.now()
    const lines = absence.buildAbsenceLines({ input: { awayStart: now - ms, awayEnd: now } })
    if (lines.length) ensureAbsenceDiary(lines, now)
    return lines
  })

  handle(CH.openMail, () => {
    createMailWindow()
    return true
  })

  handle(CH.bumpInteraction, () => {
    bumpInteraction()
    return true
  })

  handle(CH.quitApp, () => {
    state.isQuitting = true
    app.quit()
    return true
  })

  handle(CH.openLegal, (_e, key: unknown) => {
    createLegalWindow(typeof key === 'string' ? key : 'privacy')
    return true
  })

  handle(CH.openSettings, () => {
    createSettingsWindow()
    return true
  })

  handle(CH.previewBallAnim, () => {
    const win = windows.ball && !windows.ball.isDestroyed() ? windows.ball : createBallWindow()
    win.show()
    win.focus()
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win.webContents.send(EV.previewBallAnim))
    else win.webContents.send(EV.previewBallAnim)
    logger.info('main.anim', 'preview requested')
    return true
  })

  // ---------- 对话 ----------
  handle(CH.openAiInput, () => {
    openAiInputWindow()
    return true
  })

  handle(CH.closeAiInput, () => {
    if (windows.aiInput && !windows.aiInput.isDestroyed()) windows.aiInput.hide()
    return true
  })

  handle(CH.resetAgentChat, () => resetChat())

  handle(CH.aiInterpretAsk, async (_e, payload: unknown) => {
    const q = (payload && typeof payload === 'object' ? (payload as { query?: unknown }).query : '') || ''
    return handleAsk(String(q))
  })
}

// ---------- 渲染端日志桥接 ----------
export function registerLogIpc(): void {
  ipcMain.on(CH.logInfo, (_e, scope: string, msg: string, meta?: Record<string, unknown>) =>
    logger.info(scope, msg, meta || {}),
  )
  ipcMain.on(CH.logWarn, (_e, scope: string, msg: string, meta?: Record<string, unknown>) =>
    logger.warn(scope, msg, meta || {}),
  )
  ipcMain.on(CH.logError, (_e, scope: string, msg: string, meta?: Record<string, unknown>) =>
    logger.error(scope, msg, meta || {}),
  )
  ipcMain.on(CH.logCritical, (_e, scope: string, msg: string, meta?: Record<string, unknown>) =>
    logger.critical(scope, msg, meta || {}),
  )
}
