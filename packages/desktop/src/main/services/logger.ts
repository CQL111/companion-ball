// logger.ts - 主进程结构化日志（零依赖，纯 Node fs）
// 4 个级别：info / warn / error / critical
// 文件：%APPDATA%/companion-ball/logs/main-YYYY-MM-DD.log
// rotation：单文件 5MB 触发；最多保留 10 个旧文件

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { Logger } from '../../core/logger-types'

type Level = 'info' | 'warn' | 'error' | 'critical'

const LEVELS: Record<Level, number> = { info: 1, warn: 2, error: 3, critical: 4 }

let currentLevel = LEVELS.info
let logDir: string | null = null
let currentFile: string | null = null
let currentSize = 0
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const MAX_FILES = 10

// 敏感字段 redact（写入时）
const REDACT_KEYS = ['token', 'apiKey', 'api_key', 'password', 'Authorization']
function redact(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object') return meta
  const out: Record<string, unknown> | unknown[] = Array.isArray(meta) ? [] : {}
  for (const k of Object.keys(meta as Record<string, unknown>)) {
    const v = (meta as Record<string, unknown>)[k]
    if (REDACT_KEYS.some((rk) => k.toLowerCase().includes(rk.toLowerCase()))) {
      ;(out as Record<string, unknown>)[k] =
        typeof v === 'string' && v.length > 8 ? v.slice(0, 4) + '***' + v.slice(-4) : '***'
    } else if (v && typeof v === 'object') {
      ;(out as Record<string, unknown>)[k] = redact(v)
    } else {
      ;(out as Record<string, unknown>)[k] = v
    }
  }
  return out
}

export function getLogDir(): string {
  if (!logDir) {
    const base = (app && app.getPath) ? app.getPath('userData') : path.join(os.homedir(), '.companion-ball')
    logDir = path.join(base, 'logs')
  }
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
  return logDir
}

function dateStamp(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getLogFile(): string {
  const today = dateStamp()
  const expected = path.join(getLogDir(), `main-${today}.log`)
  if (currentFile !== expected) {
    currentFile = expected
    try {
      currentSize = fs.existsSync(currentFile) ? fs.statSync(currentFile).size : 0
    } catch {
      currentSize = 0
    }
  }
  return currentFile
}

function rotate(): void {
  const dir = getLogDir()
  const today = dateStamp()
  const cur = path.join(dir, `main-${today}.log`)
  try {
    for (let i = MAX_FILES; i >= 1; i--) {
      const old = path.join(dir, `main-${today}.${i}.log`)
      if (i === MAX_FILES && fs.existsSync(old)) {
        fs.unlinkSync(old)
      } else if (fs.existsSync(old)) {
        fs.renameSync(old, path.join(dir, `main-${today}.${i + 1}.log`))
      }
    }
    if (fs.existsSync(cur)) fs.renameSync(cur, path.join(dir, `main-${today}.1.log`))
  } catch (e) {
    console.error('[logger] rotation failed:', (e as Error).message)
  }
  currentFile = cur
  currentSize = 0
}

function formatLine(level: Level, scope: string, msg: string, meta?: unknown): string {
  const ts = new Date().toISOString()
  let line = `[${ts}] [${level.toUpperCase()}] [${scope}] ${msg}`
  const redactedMeta = redact(meta)
  if (redactedMeta && Object.keys(redactedMeta).length > 0) {
    try {
      line += ' ' + JSON.stringify(redactedMeta)
    } catch {
      line += ' [unserializable meta]'
    }
  }
  return line + '\n'
}

function write(level: Level, scope: string, msg: string, meta?: unknown): void {
  if (LEVELS[level] < currentLevel) return
  const line = formatLine(level, scope, msg, meta)

  if (level === 'error' || level === 'critical') console.error(line.trimEnd())
  else console.log(line.trimEnd())

  try {
    const file = getLogFile()
    if (currentSize + line.length > MAX_FILE_SIZE) rotate()
    fs.appendFileSync(file, line, 'utf8')
    currentSize += Buffer.byteLength(line, 'utf8')
  } catch (e) {
    console.error('[logger] write failed:', (e as Error).message)
  }
}

export function setLevel(level: Exclude<Level, 'critical' | 'error' | 'warn'> | 'warn' | 'error'): void {
  if (LEVELS[level]) {
    currentLevel = LEVELS[level]
    write('info', 'logger', `level set to ${level}`)
  }
}

export function getLevel(): Level {
  return (Object.keys(LEVELS) as Level[]).find((k) => LEVELS[k] === currentLevel) || 'info'
}

export function readTodayLog(): string {
  try {
    const file = getLogFile()
    if (!fs.existsSync(file)) return ''
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export function tailSince(fromIndex: number): string[] {
  return readTodayLog().split('\n').slice(fromIndex)
}

export function listLogFiles(): string[] {
  try {
    return fs.readdirSync(getLogDir()).filter((f) => f.endsWith('.log')).map((f) => path.join(getLogDir(), f))
  } catch {
    return []
  }
}

export function clearAll(): boolean {
  try {
    for (const f of listLogFiles()) {
      try {
        fs.unlinkSync(f)
      } catch {
        /* ignore */
      }
    }
    currentSize = 0
    currentFile = null
    return true
  } catch {
    return false
  }
}

export const logger: Logger = {
  info: (scope, msg, meta) => write('info', scope, msg, meta),
  warn: (scope, msg, meta) => write('warn', scope, msg, meta),
  error: (scope, msg, meta) => write('error', scope, msg, meta),
  critical: (scope, msg, meta) => write('critical', scope, msg, meta),
}
