// tests/e2e/return.mjs - S4 修复：「息屏/睡眠后回来，它要认出你」
//
// 真实故障：合盖睡眠醒来后，主进程不发 presence-back，
// 而且即使发了，渲染端也从没把 justReturned 传给 chooseObservation——
// 所以无论离开多久，它都只会说一句普通的 tap 台词。
//
// 验证点：
//   1. 离开 3 小时回来 → 冒气泡，且是「回来」组的话
//   2. 回来那一刻是 sulk（不是立刻又睡着）
//   3. 离开 10 秒回来 → 不开口（不值得打断）
//
// 用法：npm run build:e2e && node tests/e2e/return.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const REPO_ROOT = path.resolve(ROOT, '..', '..')
const ELECTRON = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9453
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-return-'))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
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
    JSON.stringify({ consentVersion: agreement, persona: 'cat', position: { x: 1200, y: 650 }, animations: true, sound: false }, null, 2),
  )
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

  const list = await targets()
  const pet = list.find((t) => t.url.includes('/pet/'))
  check('宠物窗口启动', !!pet)
  if (!pet) throw new Error('没有宠物窗口')
  await sleep(2500)

  // 确保不是睡着的（睡着时任何主动表达都暂停，那是另一条正确规则）
  await evalIn(pet, `window.debugSleep(false)`)

  const HOUR = 3600 * 1000

  // ---- 1) 离开 3 小时回来：应该认出你 ----
  await evalIn(pet, `window.debugReturn(${3 * HOUR})`)
  await sleep(1600) // evaluateSpeech 每秒一次

  const first = await evalIn(
    pet,
    `(() => {
      const b = document.getElementById('pet-bubble')
      return { text: b ? b.textContent : null, shown: b ? b.classList.contains('show') : false,
               mood: document.getElementById('ball')?.getAttribute('data-mood') }
    })()`,
  )
  check('回来后有气泡', !!first?.shown && !!first.text, JSON.stringify(first))
  // 「回来」组的话（你回来了 / 我等了一会儿 / 去哪了 / 回来就好 …）
  check('说的是「回来」的话', /回来了|等了|去哪|安静|回来就好|在这儿|味道/.test(String(first?.text)), String(first?.text))
  check('回来那一刻是悶的（sulk）', String(first?.mood) === 'sulk', String(first?.mood))

  // ---- 2) 离开 10 秒回来：不值得打断 ----
  await sleep(3500) // 等气泡自然消失
  await evalIn(pet, `(() => { const b = document.getElementById('pet-bubble'); if (b) { b.textContent=''; b.classList.remove('show') } })()`)
  await evalIn(pet, `window.debugReturn(${10 * 1000})`)
  await sleep(1600)
  const second = await evalIn(
    pet,
    `(() => {
      const b = document.getElementById('pet-bubble')
      return { text: b ? b.textContent : null, shown: b ? b.classList.contains('show') : false }
    })()`,
  )
  check('短离开不开口', !second?.shown && !second?.text, JSON.stringify(second))
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
console.log(`\n[return] ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
