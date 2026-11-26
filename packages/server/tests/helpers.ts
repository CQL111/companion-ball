// tests/helpers.ts - 集成测试骨架
//
// handler.ts 的签名天生可测：handleRequest(req, cfg) —— 不用起 HTTP 服务器。
// 每个测试用独立内存库 + 全量迁移，彼此隔离。

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sqliteAdapter, type Db } from '../src/db'
import type { ServerConfig } from '../src/handler'
import { migrate } from '../src/migrate'

const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations')

export const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((version) => ({ version, sql: readFileSync(resolve(MIGRATIONS_DIR, version), 'utf8') }))

/** 内存库 + 全量迁移 */
export async function makeDb(): Promise<Db> {
  const db = sqliteAdapter(':memory:', () => new DatabaseSync(':memory:'))
  await migrate(db, migrations)
  return db
}

export const TOKEN = 'test-device-token-0123456789'
export const OTHER_TOKEN = 'other-device-token-0123456789'

export function makeCfg(db: Db, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    db,
    trustProxy: false,
    siteOrigin: 'https://boringtime.cn',
    totpMasterKey: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64'),
    limits: {
      bottleTtlDays: 7,
      maxPicks: 3,
      dailyBottleLimit: 3,
      dailyReplyLimit: 10,
      pickPerHour: 10,
      inboxPerHour: 20,
      reportPerDay: 20,
      ipPerMinute: 1000,
      emergencyOff: false,
    },
    ...overrides,
  }
}

export interface PostOptions {
  token?: string | null
  headers?: Record<string, string>
  method?: string
  /** 直接给 ?query */
  query?: string
}

export function req(path: string, body?: unknown, opts: PostOptions = {}): Request {
  const method = opts.method ?? (body === undefined ? 'GET' : 'POST')
  const headers = new Headers(opts.headers ?? {})
  if (opts.token !== null && opts.token !== undefined) headers.set('X-Device-Token', opts.token)
  else if (body !== undefined && opts.token === undefined) headers.set('X-Device-Token', TOKEN)
  let payload: string | undefined
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
    payload = JSON.stringify(body)
  }
  return new Request(`https://boringtime.cn${path}${opts.query ?? ''}`, { method, headers, body: payload })
}

export function reqWithToken(path: string, token: string, body?: unknown): Request {
  return req(path, body, { token })
}

export async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/** 把时间往前推，方便测「明天」「7 天后」 */
export function hoursAgo(h: number, base = Date.now()): number {
  return base - h * 3600000
}
