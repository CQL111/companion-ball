// tests/e2e/dailylog.mjs - M7 日常记事真机验证
//
// 验证点：
//   1. 「今天花了10块」被记下（走真实抽取路径）
//   2. 晚间能复述（18 点后），且一天只一次
//   3. 复述用用户自己的说法，不出现总额、不评价
//   4. 「明天花10块」不记为日常（那是事件记忆的活）
//   5. 能删除
//
// 用法：npm run build:e2e && node tests/e2e/dailylog.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const REPO_ROOT = path.resolve(ROOT, '..', '..')
const ELECTRON = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9452
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-daily-'))

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

  // 1) 记一条
  const ok1 = await evalIn(pet, `window.api.dailyDebugRemember('今天花了10块')`)
  check('「今天花了10块」被记下', ok1 === true)

  const ok2 = await evalIn(pet, `window.api.dailyDebugRemember('喝了3杯咖啡')`)
  check('「喝了3杯咖啡」被记下', ok2 === true)

  // 2) 未来的事不记为日常
  const future = await evalIn(pet, `window.api.dailyDebugRemember('明天花10块买咖啡')`)
  check('「明天花10块」不记为日常', future === false)

  // 3) 列表能查到
  const listView = await evalIn(pet, `window.api.dailyNotesList()`)
  const total = (listView?.days ?? []).reduce((n, d) => n + d.notes.length, 0)
  check('列表里有 2 条', total === 2, `${total} 条`)

  // 4) 晚间复述
  const recap = await evalIn(pet, `window.api.dailyRecapPeek()`)
  const hour = new Date().getHours()
  if (hour >= 18) {
    check('晚间能复述', typeof recap === 'string' && recap.length > 0, recap)
    check('复述含用户原话', String(recap).includes('花了10块') || String(recap).includes('喝了3杯'), recap)
    check('复述不出现总额', !/一共|合计|总共|累计|总计/.test(String(recap)))
    check('复述不评价', !/有点多|太多了|要注意|省点/.test(String(recap)))

    // 标记后不再复述
    const marked = await evalIn(pet, `window.api.dailyRecapMark()`)
    const again = await evalIn(pet, `window.api.dailyRecapPeek()`)
    // 标记后不应再返回同一句（null / undefined / 空都算正确）
    check('一天只复述一次', !again, `mark=${marked} peek=${JSON.stringify(again)}`)
  } else {
    // 注意：CDP 把 null 序列化成 value:null，evalIn 里的 `??` 会把它变成 undefined。
    // 所以这里判「假值」，不能写 === null。
    check('18 点前不复述（当前 ' + hour + ' 点）', !recap, JSON.stringify(recap))
  }

  // 5) 删除
  const firstId = (listView?.days ?? [])[0]?.notes?.[0]?.id
  if (firstId) {
    const removed = await evalIn(pet, `window.api.dailyNoteRemove(${JSON.stringify(firstId)})`)
    check('能删除一条', removed === true)
    const after = await evalIn(pet, `window.api.dailyNotesList()`)
    const remaining = (after?.days ?? []).reduce((n, d) => n + d.notes.length, 0)
    check('删除后少一条', remaining === total - 1, `${remaining} 条`)
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
console.log(`\n[dailylog] ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
