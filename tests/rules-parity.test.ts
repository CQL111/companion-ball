// tests/rules-parity.test.ts - 防止客户端与服务端的瓶子规则漂移
// 背景：Workers 不能 import 仓库里的 TS 源码，server/src/rules.ts 是 src/core/mailbox.ts 的副本。
// 副本最大的风险是「改了一边忘了另一边」。这里直接读取两份源码，比对常量、内容策略与词表。

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const CLIENT = fs.readFileSync(path.join(ROOT, 'src/core/mailbox.ts'), 'utf8')
const SERVER = fs.readFileSync(path.join(ROOT, 'server/src/rules.ts'), 'utf8')

function extractConst(src: string, name: string): number | null {
  const m = new RegExp(`export const ${name} = (\\d+)`).exec(src)
  return m ? Number(m[1]) : null
}

function extractStringConst(src: string, name: string): string | null {
  // 声明可能带类型标注：export const X: 'open' | 'filtered' = 'open'
  const m = new RegExp(`export const ${name}(?::[^=]+)? = '([^']*)'`).exec(src)
  return m ? (m[1] ?? null) : null
}

/** 提取某个数组字面量里的所有字符串元素 */
function extractWordSet(src: string, decl: string): string[] {
  const start = src.indexOf(decl)
  if (start < 0) return []
  const end = src.indexOf(']', start)
  const block = src.slice(start, end < 0 ? undefined : end)
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort()
}

describe('客户端与服务端规则一致性', () => {
  it('内容长度与生命周期常量一致', () => {
    for (const name of ['BOTTLE_MAX_LENGTH', 'REPLY_MAX_LENGTH', 'BOTTLE_TTL_DAYS', 'MAX_PICKS']) {
      const c = extractConst(CLIENT, name)
      const s = extractConst(SERVER, name)
      expect(s, `${name} 在服务端缺失`).not.toBeNull()
      expect(s, `${name} 两边不一致`).toBe(c)
    }
  })

  it('内容审核策略一致（open = 不限制内容）', () => {
    const c = extractStringConst(CLIENT, 'CONTENT_POLICY')
    const s = extractStringConst(SERVER, 'CONTENT_POLICY')
    expect(c, '客户端缺少 CONTENT_POLICY').not.toBeNull()
    expect(s, '服务端缺少 CONTENT_POLICY').not.toBeNull()
    expect(s).toBe(c)
  })

  it('匿名代号词表一致', () => {
    const adjC = extractWordSet(CLIENT, 'ALIAS_ADJECTIVES')
    const adjS = extractWordSet(SERVER, 'ADJ')
    const nounC = extractWordSet(CLIENT, 'ALIAS_NOUNS')
    const nounS = extractWordSet(SERVER, 'NOUN')
    expect(adjC.length).toBeGreaterThan(0)
    expect(adjS).toEqual(adjC)
    expect(nounS).toEqual(nounC)
  })
})
