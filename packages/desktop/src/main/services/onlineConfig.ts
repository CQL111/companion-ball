// onlineConfig.ts - 线上模型配置
// 默认从本地 .env 读；设置面板里填的 store.aiConfig 覆盖空白项以外的字段

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AiConfig, AiSource } from '../../shared/types'

export interface BundledAi {
  baseUrl: string
  token: string
  model: string
}

export interface ResolvedOnline {
  baseUrl: string
  token: string
  model: string
  tokenSource: AiSource
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

function appRoot(): string {
  // dev: packages/desktop/out/main/index.js → packages/desktop
  // packaged: resources/app.asar → 同上两级结构
  return path.join(__dirname, '..', '..')
}

/** 仓库根（monorepo 根）：.env 在这里；打包后不存在，调用方会跳过 */
function repoRoot(): string {
  return path.join(appRoot(), '..', '..')
}

// 构建时内置的 Key：打包后位于 resources/bundled-ai.json（见 electron-builder.key.yml）
export function loadBundled(): BundledAi | null {
  const candidates: string[] = []
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bundled-ai.json'))
  // 开发态也允许用本地 build/ 验证「内置 Key」流程
  candidates.push(path.join(appRoot(), 'bundled-ai.json'))
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (j && typeof j.token === 'string' && j.token.trim()) {
        return {
          baseUrl: String(j.baseUrl || '').trim(),
          token: j.token.trim(),
          model: String(j.model || '').trim(),
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

function loadLocalEnv(): Record<string, string> {
  const files = [
    path.join(repoRoot(), '.env'),
    path.join(appRoot(), '.env'),
    path.join(process.cwd(), '.env'),
  ]
  if (process.resourcesPath) files.push(path.join(process.resourcesPath, '.env'))
  for (const f of files) {
    try {
      if (fs.existsSync(f)) return parseEnv(fs.readFileSync(f, 'utf8'))
    } catch {
      /* ignore */
    }
  }
  return {}
}

// 用户显式设置的键优先，其次 .env；空字符串视为未设置。
// 注意：不要把整个 process.env 混进来——机器上无关的 DEEPSEEK_* 环境变量会让「未配置」判断失效
function fromEnv(): ResolvedOnline {
  const fileEnv = loadLocalEnv()
  const rawBundled = loadBundled()
  const bundled: Record<string, string> = rawBundled
    ? {
        DEEPSEEK_BASE_URL: rawBundled.baseUrl || '',
        DEEPSEEK_API_KEY: rawBundled.token || '',
        DEEPSEEK_MODEL: rawBundled.model || '',
      }
    : {}
  const pick = (key: string, fallback: string): string => {
    const fromFile = typeof fileEnv[key] === 'string' ? fileEnv[key]!.trim() : ''
    const fromProcess = typeof process.env[key] === 'string' ? process.env[key]!.trim() : ''
    return fromFile || fromProcess || bundled[key] || fallback
  }
  const envHasKey =
    (typeof fileEnv.DEEPSEEK_API_KEY === 'string' && !!fileEnv.DEEPSEEK_API_KEY.trim()) ||
    (typeof process.env.DEEPSEEK_API_KEY === 'string' && !!process.env.DEEPSEEK_API_KEY.trim())
  return {
    baseUrl: pick('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
    token: pick('DEEPSEEK_API_KEY', ''),
    model: pick('DEEPSEEK_MODEL', 'deepseek-chat'),
    tokenSource: envHasKey ? 'env' : bundled.DEEPSEEK_API_KEY ? 'bundled' : 'none',
  }
}

// 懒加载：避免模块初始化时 app 尚未 ready / resourcesPath 未就绪
let envCfg: ResolvedOnline | null = null
function env(): ResolvedOnline {
  if (!envCfg) envCfg = fromEnv()
  return envCfg
}

/**
 * 解析最终生效的线上配置
 * preferEnv=true（开发模式）：本机 .env 优先于已保存的 Key
 * 默认（发布版）：设置面板 > .env / 内置 Key
 */
export function resolve(saved: Partial<AiConfig> | null | undefined, opts: { preferEnv?: boolean } = {}): ResolvedOnline {
  const s = saved && typeof saved === 'object' ? saved : {}
  const hasUser = (k: keyof AiConfig): boolean => typeof s[k] === 'string' && !!(s[k] as string).trim()
  const e = env()
  const envToken = e.token || ''
  const preferEnv = opts.preferEnv === true && !!envToken
  const pick = (key: keyof AiConfig): string => {
    if (preferEnv && key === 'token') return envToken
    return hasUser(key) ? (s[key] as string).trim() : e[key] || ''
  }
  return {
    baseUrl: pick('baseUrl'),
    token: pick('token'),
    model: pick('model') || 'deepseek-chat',
    tokenSource: preferEnv ? e.tokenSource : hasUser('token') ? 'user' : e.tokenSource,
  }
}

export function maskToken(token: string): string {
  const t = String(token || '')
  if (!t) return ''
  if (t.length <= 8) return '••••'
  return t.slice(0, 3) + '••••' + t.slice(-4)
}

export function isPackaged(): boolean {
  return !!app?.isPackaged
}
