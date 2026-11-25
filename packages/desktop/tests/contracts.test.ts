// tests/contracts.test.ts - 契约唯一源守护
// 背景：改造前 src/core/mailbox.ts 与 server/src/rules.ts 是两份手抄副本，
// 靠 tests/rules-parity.test.ts 比对防漂移。2026-11-25 起规则本体只有一份
// （packages/contracts），本测试改为守护「唯一源」这个事实本身：
//   1. contracts 包零平台依赖、零运行时依赖
//   2. 桌面端 mailbox.ts 只是 re-export，没有第二份规则
//   3. 服务端不再存在 rules.ts 副本，index.ts 从 @companion/contracts 引用
//   4. 关键常量与行为仍与历史一致（防止搬动时手滑改数值）

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOTTLE_MAX_LENGTH,
  BOTTLE_TTL_DAYS,
  CONTENT_POLICY,
  DAILY_BOTTLE_LIMIT,
  MAX_PICKS,
  REPLY_MAX_LENGTH,
  ALIAS_ADJECTIVES,
  ALIAS_NOUNS,
  checkText,
  poolFor,
  randomAlias,
} from '@contracts'

const PKG = path.resolve(__dirname, '..') // packages/desktop
const REPO_ROOT = path.resolve(PKG, '..', '..')
const CONTRACTS_SRC = path.join(REPO_ROOT, 'packages/contracts/src')
const SERVER_SRC = path.join(REPO_ROOT, 'packages/server/src')

function readAll(dir: string): Array<{ name: string; src: string }> {
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.ts'))
    .map((n) => ({ name: n, src: fs.readFileSync(path.join(dir, n), 'utf8') }))
}

describe('契约唯一源', () => {
  it('关键常量与历史保持一致', () => {
    expect(BOTTLE_MAX_LENGTH).toBe(60)
    expect(REPLY_MAX_LENGTH).toBe(60)
    expect(BOTTLE_TTL_DAYS).toBe(7)
    expect(MAX_PICKS).toBe(3)
    expect(DAILY_BOTTLE_LIMIT).toBe(3)
    expect(CONTENT_POLICY).toBe('open')
  })

  it('桌面端 mailbox.ts 只是 re-export，不再定义第二份常量', () => {
    const src = fs.readFileSync(path.join(PKG, 'src/core/mailbox.ts'), 'utf8')
    expect(src).toContain("export * from '@contracts'")
    expect(src).not.toMatch(/export const BOTTLE_MAX_LENGTH/)
    expect(src).not.toMatch(/export function poolFor/)
    expect(src).not.toMatch(/export function checkText/)
  })

  it('服务端不再存在手抄副本，业务从契约包引用', () => {
    expect(fs.existsSync(path.join(SERVER_SRC, 'rules.ts'))).toBe(false)
    const handler = fs.readFileSync(path.join(SERVER_SRC, 'handler.ts'), 'utf8')
    expect(handler).toContain("from '@companion/contracts'")
    expect(handler).not.toMatch(/from '\.\/rules'/)
  })

  it('服务端业务层不依赖任何平台类型（D1Database / node:）', () => {
    const handler = fs.readFileSync(path.join(SERVER_SRC, 'handler.ts'), 'utf8')
    const db = fs.readFileSync(path.join(SERVER_SRC, 'db.ts'), 'utf8')
    // 业务层必须平台无关：两个运行时（Workers / Node）共用它
    expect(handler, 'handler 不应出现 D1Database').not.toMatch(/D1Database/)
    expect(handler, 'handler 不应 import node:').not.toMatch(/from ['"]node:/)
    // D1Database 只允许出现在适配器文件 db.ts 里
    expect(db).toMatch(/D1Database/)
  })

  it('contracts 包零平台依赖、零运行时依赖', () => {
    for (const { name, src } of readAll(CONTRACTS_SRC)) {
      expect(src, `${name} 不应 import node:*`).not.toMatch(/from\s+['"]node:/)
      expect(src, `${name} 不应 import electron`).not.toMatch(/from\s+['"]electron['"]/)
      expect(src, `${name} 不应依赖 zod`).not.toMatch(/from\s+['"]zod['"]/)
      expect(src, `${name} 不应直接 import 其他包`).not.toMatch(/from\s+['"][^.@][^'"]*['"]/)
    }
  })
})

describe('契约行为（搬家后仍与历史一致）', () => {
  it('时段分池按本地时间', () => {
    const at = (utcHour: number) => Date.UTC(2026, 10, 20, utcHour)
    expect(poolFor(at(15), 480)).toBe('night') // 东八区 23:00
    expect(poolFor(at(5), 480)).toBe('day') // 东八区 13:00
    expect(poolFor(at(12), 480)).toBe('evening') // 东八区 20:00
  })

  it('内容校验：空、超长、open 策略不拦截网页', () => {
    expect(checkText('   ').ok).toBe(false)
    expect(checkText('a'.repeat(61)).reason).toBe('TOO_LONG')
    expect(checkText('打 13800138000').ok).toBe(true) // open 不拦截
    expect(checkText('打 13800138000', 60, 'filtered').reason).toBe('CONTACT')
  })

  it('匿名代号词表数量不变', () => {
    expect(ALIAS_ADJECTIVES.length).toBe(12)
    expect(ALIAS_NOUNS.length).toBe(20)
    // 代号由「形容词 + 名词」组成，且可注入随机源
    const alias = randomAlias(() => 0)
    expect(alias).toBe('夜里的橘子')
  })
})
