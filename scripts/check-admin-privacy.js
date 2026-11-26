// scripts/check-admin-privacy.js - 后台隐私红线门禁
//
// 产品红线（docs/WINDOW.md 6.5）：
//   **管理员看不到私池。**
//   后台只能读：橱窗（用户主动公开）、新闻、被举报的那一条。
//
// 这条红线靠人工 review 撑不住：以后想加一个「后台搜索」时，
// 顺手写一条 SELECT * FROM bottles 太自然了。
//
// 检查方式：扫 server/src/routes/admin/** 的代码
//   - 禁止出现 FROM bottles / JOIN bottles / FROM replies / FROM picks（列表类读取）
//   - 只允许 repo/bottles 的 findByIdForReport / hideBottle / revokeToken 等精确操作
//
// 用法：node scripts/check-admin-privacy.js

const fs = require('fs')
const path = require('path')

const ADMIN_DIR = path.join(__dirname, '..', 'packages', 'server', 'src', 'routes', 'admin')

/** 禁止：对私池做列表/搜索类读取 */
const FORBIDDEN = [
  { re: /FROM\s+bottles\b/i, why: '禁止在后台查询私池表 bottles' },
  { re: /FROM\s+replies\b/i, why: '禁止在后台查询回信表 replies' },
  { re: /FROM\s+picks\b/i, why: '禁止在后台查询捡瓶记录 picks' },
]

/** 允许的精确操作（通过 repo 层；只按 id 查被举报的那一条） */
const ALLOWED_REPO_CALLS = new Set([
  'findByIdForReport',
  'hideBottle',
  'hideReply',
  'revokeToken',
  'unrevokeToken',
])

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const problems = []
const checked = []

for (const file of walk(ADMIN_DIR)) {
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/')
  const code = stripComments(fs.readFileSync(file, 'utf8'))
  checked.push(rel)

  for (const { re, why } of FORBIDDEN) {
    if (re.test(code)) problems.push(`${rel}：${why}`)
  }

  // 检查对 bottles repo 的调用：只允许白名单里的精确操作
  const calls = [...code.matchAll(/\bbottles\.([a-zA-Z]+)\s*\(/g)].map((m) => m[1])
  for (const fn of new Set(calls)) {
    if (fn && !ALLOWED_REPO_CALLS.has(fn)) {
      problems.push(
        `${rel}：调用了 bottles.${fn}() —— 后台只能通过 ${[...ALLOWED_REPO_CALLS].join(' / ')} 触达私池`,
      )
    }
  }
}

if (problems.length) {
  console.error('[check-admin-privacy] 失败：')
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error('\n如果需要新的后台能力，请先确认它不违反「管理员看不到私池」（WINDOW 6.5）。')
  process.exit(1)
}

console.log(`[check-admin-privacy] 通过（扫描了 ${checked.length} 个后台路由文件，未触碰私池列表）`)
process.exit(0)
