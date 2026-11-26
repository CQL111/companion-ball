// scripts/check-secrets.js - 防止密钥进入提交
//
// 起因（真实事故）：用户在对话里贴出了 .env，里面有 DEEPSEEK_API_KEY / GH_TOKEN /
// R2_SECRET_ACCESS_KEY。虽然 .env 被 gitignore 拦住了，但**任何文件**里都可能被误贴。
// 人工检查会漏，做成提交前门禁。
//
// 检查范围：git 已追踪 + 待提交的文件（跳过 node_modules / dist / 二进制）。
//
// 用法：
//   node scripts/check-secrets.js          # 检查已追踪文件
//   node scripts/check-secrets.js --staged # 只检查暂存区（pre-commit 用）

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const stagedOnly = process.argv.includes('--staged')

/** 已知的密钥形态。宁可误报也不放过。 */
const PATTERNS = [
  { name: 'DeepSeek / OpenAI Key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub Token (classic)', re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitHub Token (fine-grained)', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: 'AWS / R2 Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  // R2 的 Secret 是 64 位十六进制；这个形态也可能是别的哈希，所以只在赋值语境里报
  { name: '疑似 Secret 赋值', re: /(?:SECRET|TOKEN|KEY|PASSWORD)\s*=\s*['"]?[A-Za-z0-9_-]{32,}['"]?/ },
]

/** 这些文件本来就该有占位符或示例，跳过 */
const SKIP_FILES = new Set([
  '.env.example',
  'scripts/check-secrets.js',
  'docs/RELEASING.md',
])

/** 跳过目录 */
const SKIP_DIR = /(^|\/)(node_modules|dist|out|out-public|dist-public|\.git|\.wrangler|coverage)(\/|$)/

/** 跳过二进制 */
const BINARY_EXT = /\.(png|jpg|jpeg|gif|ico|webp|woff2?|ttf|otf|mp3|wav|pdf|zip|exe|dmg|asar|sqlite|db)$/i

function listFiles() {
  const args = stagedOnly
    ? 'git diff --cached --name-only --diff-filter=ACM'
    : 'git ls-files'
  try {
    return execSync(args, { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function checkFile(rel) {
  if (SKIP_FILES.has(rel)) return []
  if (SKIP_DIR.test(rel)) return []
  if (BINARY_EXT.test(rel)) return []

  let text
  try {
    text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return []
  }
  // 跳过超大文件（多半是生成物）
  if (text.length > 2_000_000) return []

  const hits = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        // 不打印密钥本身，只打印位置——避免二次泄露
        hits.push({ file: rel, line: i + 1, name })
        break
      }
    }
  }
  return hits
}

const files = listFiles()
const all = []
for (const f of files) all.push(...checkFile(f))

if (all.length) {
  console.error('[check-secrets] 失败：检测到疑似密钥')
  for (const h of all) console.error(`  ✗ ${h.file}:${h.line}  ${h.name}`)
  console.error('\n处理方法：')
  console.error('  1. 如果这是真实密钥 → 立刻轮换（GitHub / DeepSeek / Cloudflare 控制台）')
  console.error('  2. 把值移到 .env（已被 gitignore），代码里只读环境变量')
  console.error('  3. 占位符写成 sk-xxx / ghp_xxx / <your-token>')
  process.exit(1)
}

console.log(`[check-secrets] 通过（检查了 ${files.length} 个文件）`)
process.exit(0)
