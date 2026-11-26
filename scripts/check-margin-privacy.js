// scripts/check-margin-privacy.js - P2 红线门禁：页边一句话不出网
//
// 产品红线（docs/ROADMAP.md P2 验收）：
//   「无一条页边内容进入任何出网通路」
//
// 为什么做成机器检查：以后任何一个人想「发送前顺手带上笔记本内容」都很自然，
// 靠人工 review 撑不住。
//
// 检查方式（看**实参**，不看 import —— 模块级判断会在 IPC 分发器上误报）：
//   找到所有「把内容发出去」的调用（callLLM / handleAsk / throwBottle / replyBottle /
//   reportContent / fetch ...），取出括号里的实参文本；
//   如果实参里出现笔记本正文（getNotebook / .entries / toMarkdown）或页边字段（margin）
//   → 失败。
//
// 用法：node scripts/check-margin-privacy.js

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'packages', 'desktop', 'src')

/** 会把内容发到网络上的函数（名字 -> 说明）。注意：pullModel / lookupCity 只发模型名/城市名，不在列。 */
const SENDERS = ['callLLM', 'handleAsk', 'throwBottle', 'replyBottle', 'reportContent', 'fetch']

/** 实参里出现这些 → 说明笔记本/页边内容被送出去了 */
const FORBIDDEN_ARG = /\bmargin\b|getNotebook\s*\(|\.entries\b|toMarkdown\s*\(/

/** 去掉注释，避免注释文字误报 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 从 open 位置的 '(' 开始，取出到配对的 ')' 为止（跳过字符串里的括号） */
function argsAt(src, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return src.slice(open + 1)
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const problems = []
let callCount = 0

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  if (rel.startsWith('renderer/')) continue // 渲染端无 node 权限，不直接出网

  const code = stripComments(fs.readFileSync(file, 'utf8'))
  const names = SENDERS.join('|')
  // 匹配 fnName(  或  obj.fnName(  或  fetch(
  const re = new RegExp(`(?:^|[^\\w.])(${names})\\s*\\(`, 'g')
  let m
  while ((m = re.exec(code)) !== null) {
    const open = code.indexOf('(', m.index + m[0].length - 1)
    if (open < 0) continue
    callCount++
    const args = argsAt(code, open)
    if (FORBIDDEN_ARG.test(args)) {
      problems.push(
        `${rel}:${lineOf(code, m.index)} ${m[1]}() 的实参里出现笔记本/页边内容 —— ` +
          `页边一句话不允许进入任何出网通路（P2 红线）`,
      )
    }
  }
}

if (problems.length) {
  console.error('[check-margin-privacy] 失败：')
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error('\n页边一句话只能留在本地：不要把它当作任何网络调用的入参。')
  process.exit(1)
}

console.log(`[check-margin-privacy] 通过（检查了 ${callCount} 处出网调用的实参，均不含页边/笔记本正文）`)
process.exit(0)
