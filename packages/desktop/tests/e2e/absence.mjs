// tests/e2e/absence.mjs - P1 缺席日记真机验证
//
// 验证点：
//   1. 模拟 9 小时缺席 → 生成日记行，且被写进笔记本
//   2. 不同时长给出不同的话（不是固定模板）
//   3. 少于 8 小时不写（允许空白）
//   4. 之后再跑常规日记，缺席内容不被覆盖
//
// 用法：npm run build && node tests/e2e/absence.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const REPO_ROOT = path.resolve(ROOT, '..', '..')
const ELECTRON = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9446
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-absence-'))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      if (list.length) return list
    } catch {
      /* 端口还没起来 */
    }
    await sleep(500)
  }
  return []
}

async function evalIn(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let id = 0
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  await new Promise((r) => (ws.onopen = r))
  const res = await new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(
      JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }),
    )
  })
  ws.close()
  return res.result?.result?.value ?? res.result?.exceptionDetails?.text
}

function seed() {
  let agreement = 1
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src/main/windows.ts'), 'utf8')
    const m = /AGREEMENT_VERSION = (\d+)/.exec(src)
    if (m) agreement = Number(m[1])
  } catch {
    /* ignore */
  }
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ consentVersion: agreement, persona: 'cat', position: { x: 1200, y: 650 }, animations: true, sound: false }, null, 2),
  )
}

const HOUR = 3600_000
let child
try {
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
    console.error('❌ 未构建，请先 npm run build')
    process.exit(1)
  }
  seed()
  child = spawn(ELECTRON, ['.', '--hidden', `--user-data-dir=${TMP}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore',
  })

  const list = await targets()
  const pet = list.find((t) => t.url.includes('/pet/'))
  check('宠物窗口启动', !!pet)
  if (!pet) throw new Error('没有宠物窗口')
  await sleep(2500)

  // 1) 9 小时缺席 → 应该写出内容
  const lines9 = await evalIn(pet, `window.api.debugAbsenceDiary(${9 * HOUR})`)
  check('9 小时缺席生成日记', Array.isArray(lines9) && lines9.length > 0, JSON.stringify(lines9))
  check('日记不含数字', Array.isArray(lines9) && lines9.every((l) => !/[0-9０-９]/.test(l)))

  // 2) 已写进笔记本
  const nb = await evalIn(pet, `window.api.getNotebookView()`)
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const entry = nb?.entries?.find((e) => e.date === key)
  check('缺席内容已进笔记本', !!entry && Array.isArray(lines9) && lines9.some((l) => entry.lines.includes(l)), entry ? `${entry.lines.length} 句` : '无条目')

  // 3) 2 小时不写（允许空白）
  const lines2 = await evalIn(pet, `window.api.debugAbsenceDiary(${2 * HOUR})`)
  check('2 小时缺席不写', Array.isArray(lines2) && lines2.length === 0, JSON.stringify(lines2))

  // 4) 10 天给出不同的内容
  const lines10 = await evalIn(pet, `window.api.debugAbsenceDiary(${10 * 24 * HOUR})`)
  check('10 天缺席生成内容', Array.isArray(lines10) && lines10.length > 0)
  check('不同时长内容不同', Array.isArray(lines9) && Array.isArray(lines10) && JSON.stringify(lines9) !== JSON.stringify(lines10))

  // 5) 常规日记不覆盖缺席内容
  const nb2 = await evalIn(pet, `window.api.getNotebookView()`)
  const entry2 = nb2?.entries?.find((e) => e.date === key)
  check('缺席内容仍在（未被覆盖）', !!entry2 && Array.isArray(lines9) && lines9.some((l) => entry2.lines.includes(l)), entry2 ? entry2.lines.join(' / ') : '无')

  // 6) 日记行数不超过 4
  check('日记不超过 4 句', !!entry2 && entry2.lines.length <= 4, entry2 ? String(entry2.lines.length) : '')
} catch (e) {
  check('执行未抛异常', false, String(e?.message || e))
} finally {
  if (child) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
  try {
    const { execSync } = await import('node:child_process')
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='electron.exe'\\" | Where-Object { $_.CommandLine -like '*${TMP.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
      { stdio: 'ignore' },
    )
  } catch {
    /* ignore */
  }
  fs.rmSync(TMP, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n[absence] ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
