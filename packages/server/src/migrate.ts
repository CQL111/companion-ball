// migrate.ts - 有序迁移（D1 与 node:sqlite 共用同一套文件）
//
// 为什么需要：原来的 schema.sql 用的是 CREATE TABLE IF NOT EXISTS，
// 对**已建库**永远不生效——加字段、加表都会静默失败。现在改成只前进的迁移。
//
// 规则（BUILD-PLATFORM 第三节）：
//   1. 迁移只前进，不改已发布的文件
//   2. 每个文件必须能在空库上从头跑通（集成测试会验证）
//   3. D1 用 wrangler d1 migrations apply；Node 用本文件
//
// 本文件不依赖 node:fs、不依赖 D1 类型——SQL 文本由调用方注入，
// 这样 Worker 运行时不会把 fs 打进去。

import type { Db } from './db'

export const MIGRATION_TABLE = 'schema_migrations'

/** 已应用的迁移版本号（已排序） */
export async function appliedVersions(db: Db): Promise<string[]> {
  await db
    .prepare(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    .bind()
    .run()
  const rows = await db.prepare(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`).bind().all<{ version: string }>()
  return (rows.results ?? []).map((r) => r.version)
}

/**
 * 把一段 SQL 按语句切分。
 *
 * 不能简单 split(';')：语句里可能有字符串常量含分号，行注释也可能含分号。
 * 这个解析器只覆盖本项目迁移文件的写法（无存储过程、无触发器体）。
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let inString: string | null = null
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    const next = sql[i + 1]

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        cur += ch
      }
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inString) {
      cur += ch
      if (ch === inString) {
        // SQL 里 '' 表示转义的单引号
        if (next === inString) {
          cur += next
          i++
        } else {
          inString = null
        }
      }
      continue
    }

    if (ch === '-' && next === '-') {
      inLineComment = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      inString = ch
      cur += ch
      continue
    }
    if (ch === ';') {
      const stmt = cur.trim()
      if (stmt) out.push(stmt)
      cur = ''
      continue
    }
    cur += ch
  }

  const tail = cur.trim()
  if (tail) out.push(tail)
  return out
}

export interface Migration {
  /** 版本号（= 文件名，如 0002_gallery.sql） */
  version: string
  sql: string
}

export interface MigrateResult {
  applied: string[]
  skipped: string[]
}

/**
 * 迁移里的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS。
 * SQLite 对已存在的列会报 "duplicate column name"——这在**重跑迁移**时是预期内的，
 * 所以把它当成「已应用」跳过，而不是视为失败。
 */
function isAlreadyApplied(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase()
  return msg.includes('duplicate column name') || msg.includes('already exists')
}

/**
 * 依次执行未应用的迁移。
 *
 * 注意：D1 的 batch 与 node:sqlite 的事务语义不同，这里逐条执行。
 * 单个迁移文件失败时（除「已存在」类错误外），已执行的部分语句会留在库里——
 * 所以每个迁移仍应尽量写成幂等（IF NOT EXISTS），集成测试会验证「重复执行无副作用」。
 */
export async function migrate(db: Db, migrations: Migration[]): Promise<MigrateResult> {
  const done = new Set(await appliedVersions(db))
  const sorted = [...migrations].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))

  const applied: string[] = []
  const skipped: string[] = []

  for (const m of sorted) {
    if (done.has(m.version)) {
      skipped.push(m.version)
      continue
    }
    for (const stmt of splitStatements(m.sql)) {
      try {
        await db.prepare(stmt).bind().run()
      } catch (e) {
        // 重跑时「列已存在 / 表已存在」是幂等的正常情况
        if (!isAlreadyApplied(e)) throw e
      }
    }
    await db
      .prepare(`INSERT INTO ${MIGRATION_TABLE} (version, applied_at) VALUES (?, ?)`)
      .bind(m.version, Date.now())
      .run()
    applied.push(m.version)
  }

  return { applied, skipped }
}
