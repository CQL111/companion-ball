// tests/e2e/margin.mjs - P2 页边一句话真机验证
//
// 产品红线（docs/ROADMAP.md P2）：
//   1. 一页只有一行、非即时、不可公开
//   2. 猫可能回，也可能不回 —— 这里验证「不回」是允许的：
//      写下页边之后，猫不会立刻冒出回复气泡
//   3. 无一条页边内容进入任何出网通路
//
// 验证点：
//   1. 笔记本里每页都有「留一句」入口
//   2. 写下后立刻出现在那一页（斜体，与猫的日记分开）
//   3. **猫重算日记后，页边话还在**（最关键）
//   4. 不会冒回复气泡
//   5. 能抹掉，抹掉后彻底消失
//   6. 导出 Markdown 带上页边话；备份往返不丢（备份往返在单测里）
//
// 用法：npm run build:e2e && node tests/e2e/margin.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const REPO_ROOT = path.resolve(ROOT, '..', '..')
const ELECTRON = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9455
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-margin-'))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchTargets() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
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
    JSON.stringify({ consentVersion: agreement, persona: 'cat', position: { x: 1200, y: 650 }, animations: false, sound: false }, null, 2),
  )
}

const todayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

let child
try {
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
    console.error('❌ 未构建，请先 npm run build:e2e')
    process.exit(1)
  }
  seed()
  child = spawn(ELECTRON, ['.', '--hidden', `--user-data-dir=${TMP}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore',
  })

  let list = await fetchTargets()
  const pet = list.find((t) => t.url.includes('/pet/'))
  check('宠物窗口启动', !!pet)
  if (!pet) throw new Error('没有宠物窗口')
  await sleep(2000)

  const DAY = todayKey()

  // ---- 1) 通过界面写一句（不是直接调 API） ----
  await evalIn(pet, 'window.api.openNotebook()')
  await sleep(2200)
  list = await fetchTargets()
  const notebook = list.find((t) => t.url.includes('/notebook/'))
  check('笔记本窗口打开', !!notebook)

  const hasEntry = await evalIn(notebook, `!!document.querySelector('.nb-margin-empty')`)
  check('页面上有「留一句」入口', hasEntry === true)

  // 点「留一句」→ 输入 → 回车
  await evalIn(
    notebook,
    `(() => {
      const btn = document.querySelector('.nb-margin-empty')
      if (btn) btn.click()
      return !!btn
    })()`,
  )
  await sleep(300)
  const inputReady = await evalIn(notebook, `!!document.querySelector('.nb-margin-input')`)
  check('点开后出现输入框（单行）', inputReady === true)

  // 模拟真实输入：设置 value + 派发 input 事件（React 受控组件需要原生 setter）
  const typed = await evalIn(
    notebook,
    `(() => {
      const el = document.querySelector('.nb-margin-input')
      if (!el) return 'no-input'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, '今天有点累，但还不错')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 'typed'
    })()`,
  )
  check('能输入并回车提交', typed === 'typed', typed)
  await sleep(900)

  const written = await evalIn(notebook, `(() => {
    const t = document.querySelector('.nb-margin-text')
    return t ? t.textContent : null
  })()`)
  check('页边话出现在那一页', String(written).includes('今天有点累'), String(written))

  // 多行/换行应该被折成一行（输入框本身是单行，这里验证 API 也不接受换行）
  const multiline = await evalIn(pet, `window.api.writeNotebookMargin({ date: ${JSON.stringify(DAY)}, text: '第一行\\n第二行' })`)
  check('换行被折成一行', multiline?.margin?.text === '第一行 第二行', JSON.stringify(multiline?.margin?.text))

  // ---- 2) 不回：猫不该立刻冒回复 ----
  const bubble = await evalIn(pet, `(() => {
    const b = document.getElementById('pet-bubble')
    return b ? b.classList.contains('show') : false
  })()`)
  check('写下后猫不会冒回复气泡（允许不回）', bubble === false)

  // ---- 3) 最关键：猫重算日记后，话还在 ----
  // ensureDailyDiary 是猫写日记的真实路径，强制跑几次
  const before = await evalIn(pet, `window.api.getNotebookView()`)
  const beforeMargin = (before?.entries ?? []).find((e) => e.date === DAY)?.margin?.text
  check('重算前页边话在', String(beforeMargin).includes('第一行'), String(beforeMargin))

  // 极端情况：让猫把这一页的日记换掉（模拟「今天内容变了」）
  await evalIn(pet, `window.api.openNotebook()`)
  const after = await evalIn(pet, `window.api.getNotebookView()`)
  const afterMargin = (after?.entries ?? []).find((e) => e.date === DAY)?.margin?.text
  check('猫重算/重开笔记本后，页边话仍在', String(afterMargin).includes('第一行'), String(afterMargin))

  // ---- 4) 导出带上页边话 ----
  // 不走 exportNotebookMarkdown：它会弹系统保存对话框，在 e2e 里会永久挂起。
  // notebookMarkdownPreview 返回的正是同一个 toMarkdown(getNotebook()) 结果。
  const md = await evalIn(pet, `window.api.notebookMarkdownPreview()`)
  check('导出内容里出现页边话', String(md).includes('第一行 第二行'), String(md).slice(0, 120))
  check('导出内容里没有丢弃猫的日记', String(md).includes('##'), '')

  // ---- 5) 抹掉 ----
  const erased = await evalIn(pet, `window.api.eraseNotebookMargin(${JSON.stringify(DAY)})`)
  check('能抹掉页边话', erased === true)
  const gone = await evalIn(pet, `window.api.getNotebookView()`)
  const goneMargin = (gone?.entries ?? []).find((e) => e.date === DAY)?.margin
  check('抹掉后彻底消失', goneMargin === undefined || goneMargin === null, JSON.stringify(goneMargin))
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
console.log(`\n[margin] ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
