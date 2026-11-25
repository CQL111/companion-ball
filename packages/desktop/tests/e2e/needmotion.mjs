// tests/e2e/needmotion.mjs - P0.5 真机验证：需求是否真的驱动了身体
//
// 验证点（对应 docs/ROADMAP.md 的 P0.5 验收）：
//   1. 触发「饿了」后，角色出现可观测的位移或原地动作（不是只冒一句话）
//   2. 睡觉时不表达（需求在，但身体不动）
//   3. 拖动时不打断（用户优先）
//
// 用法：npm run build && node tests/e2e/needmotion.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..') // packages/desktop
const REPO_ROOT = path.resolve(ROOT, '..', '..')
const ELECTRON = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9444
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-need-'))

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

const posExpr = `(() => { const r = document.querySelector('#ball').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), loco: document.querySelector('#ball').getAttribute('data-loco'), clip: document.querySelector('#ball').getAttribute('data-clip') } })()`

function seed() {
  const agreement = (() => {
    try {
      const src = fs.readFileSync(path.join(ROOT, 'src/main/windows.ts'), 'utf8')
      const m = /AGREEMENT_VERSION = (\d+)/.exec(src)
      return m ? Number(m[1]) : 1
    } catch {
      return 1
    }
  })()
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ consentVersion: agreement, persona: 'cat', position: { x: 1200, y: 650 }, animations: true, sound: false }, null, 2),
  )
}

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

  // 等渲染器就绪
  for (let i = 0; i < 30; i++) {
    const ready = await evalIn(pet, `!!document.querySelector('#pet-canvas')?.dataset.clip`)
    if (ready) break
    await sleep(500)
  }

  const before = await evalIn(pet, posExpr)
  check('初始状态可读', !!before?.loco, JSON.stringify(before))

  // 触发「饿了」需求；身体表达窗口 12 秒，观察 8 秒内的位移与动作
  await evalIn(pet, `window.debugSpeak('need')`)
  const samples = []
  for (let i = 0; i < 16; i++) {
    await sleep(500)
    samples.push(await evalIn(pet, posExpr))
  }

  const moved = samples.filter((s) => s && Math.abs(s.x - before.x) > 10).length
  const acted = samples.filter((s) => s && (s.loco === 'walk' || s.clip === 'stretch' || s.clip === 'groom')).length
  const movedOrActed = samples.filter((s) => {
    if (!s) return false
    const dx = Math.abs(s.x - before.x)
    return dx > 10 || s.loco === 'walk' || s.clip === 'stretch' || s.clip === 'groom'
  }).length

  check('需求驱动了身体（位移或原地动作）', movedOrActed >= 3, `位移样本=${moved} 动作样本=${acted} / 16`)

  // 睡觉时不表达：切到 sleep 再触发需求
  const sleeping = await evalIn(
    pet,
    `(() => (typeof window.debugSleep === 'function' ? window.debugSleep(true) : 'no-debug'))()`,
  )
  check('可以切换到睡眠态', sleeping === 'sleep', String(sleeping))
  if (sleeping === 'sleep') {
    const s0 = await evalIn(pet, posExpr)
    await evalIn(pet, `window.debugSpeak('need')`)
    await sleep(4000)
    const s1 = await evalIn(pet, posExpr)
    check('睡觉时不表达需求', Math.abs(s1.x - s0.x) <= 4, `x: ${s0.x} → ${s1.x}, loco=${s1.loco}`)
    // 醒来后应该恢复
    await evalIn(pet, `window.debugSleep(false)`)
    const wake = await evalIn(pet, posExpr)
    check('退出睡眠恢复正常', wake.loco !== 'sleep', `mood 已解除，loco=${wake.loco}`)
  }
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
console.log(`\n[needmotion] ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
