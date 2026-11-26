// tests/migrate.test.ts - 迁移：空库跑通 + 幂等 + SQL 切分
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { sqliteAdapter } from '../src/db'
import { appliedVersions, migrate, splitStatements } from '../src/migrate'
import { makeDb, migrations } from './helpers'

describe('splitStatements', () => {
  it('按分号切分，忽略注释与字符串里的分号', () => {
    const sql = `
      -- 行注释里的分号; 不应切分
      CREATE TABLE a (x TEXT);
      INSERT INTO a VALUES ('半角;分号');
      /* 块注释 ;
         跨行 */
      CREATE TABLE b (y TEXT);
    `
    const stmts = splitStatements(sql)
    expect(stmts).toHaveLength(3)
    expect(stmts[1]).toContain("'半角;分号'")
  })

  it('处理转义的单引号', () => {
    const stmts = splitStatements("INSERT INTO t VALUES ('it''s;ok');")
    expect(stmts).toHaveLength(1)
    expect(stmts[0]).toContain("it''s;ok")
  })

  it('空输入返回空数组', () => {
    expect(splitStatements('')).toEqual([])
    expect(splitStatements('  -- 只有注释\n')).toEqual([])
  })
})

describe('migrate', () => {
  it('空库能从头跑到最新', async () => {
    const db = sqliteAdapter(':memory:', () => new DatabaseSync(':memory:'))
    const r = await migrate(db, migrations)
    expect(r.applied).toEqual(migrations.map((m) => m.version))
    const done = await appliedVersions(db)
    expect(done).toHaveLength(migrations.length)
  })

  it('重复执行幂等（已应用的跳过）', async () => {
    const db = await makeDb()
    const r = await migrate(db, migrations)
    expect(r.applied).toEqual([])
    expect(r.skipped).toHaveLength(migrations.length)
  })

  it('关键表都存在', async () => {
    const db = await makeDb()
    const rows = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .bind()
      .all<{ name: string }>()
    const names = rows.results.map((r) => r.name)
    for (const t of ['bottles', 'gallery_bottles', 'news', 'news_leads', 'admin_users', 'feature_flags', 'daily_stats', 'reports']) {
      expect(names).toContain(t)
    }
  })

  it('封海开关默认全关（value=0）', async () => {
    const db = await makeDb()
    const rows = await db.prepare('SELECT key, value FROM feature_flags').bind().all<{ key: string; value: number }>()
    expect(rows.results).toHaveLength(4)
    expect(rows.results.every((r) => r.value === 0)).toBe(true)
  })
})
