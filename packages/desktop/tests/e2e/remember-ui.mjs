// tests/e2e/remember-ui.mjs - 它记得的事 / 今天记下的：界面可见 + 可删
//
// 背景：P1.5 的事件记忆和 M7 的日常记事做完后，**只能用调试接口看到**。
// 用户说了「下周三面试」却无处确认、无处删除——这在产品上说不通。
//
// 验证点：
//   1. 设置窗口有「它记得的事」「今天记下的」两个分区
//   2. 说一句明天的面试 → 列表里真的出现，日期格式可读
//   3. 点 × 能划掉，划掉后不再出现
//   4. 说一句「今天花了10块」→ 「今天记下的」出现，× 能删
//   5. 笔记本里能看到「它记得的事」，但**看不到**「花了10块」（日记不说数据）
//
// 用法：npm run build:e2e && node tests/e2e/remember-ui.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const REPO_ROOT = path.resolve(ROOT, '..', '..')
const ELECTRON = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9454
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-remui-'))

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

/** 在某个窗口里点一下按钮：匹配 textContent 里含 label 的 .mem-del */
const clickDel = (label) => `(() => {
  const items = [...document.querySelectorAll('.mem-item')]
  const hit = items.find((li) => li.textContent.includes(${JSON.stringify(label)}))
  if (!hit) return 'not-found'
  const btn = hit.querySelector('.mem-del')
  if (!btn) return 'no-button'
  btn.click()
  return 'clicked'
})()`

/** 读某个分区里所有条目的文字 */
const readSection = (heading) => `(() => {
  const sec = [...document.querySelectorAll('.section')].find(
    (s) => (s.querySelector('h2')?.textContent || '') === ${JSON.stringify(heading)},
  )
  if (!sec) return null
  return [...sec.querySelectorAll('.mem-item')].map((li) => li.textContent.trim())
})()`

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

  // ---- 准备数据：走真实抽取路径 ----
  const when = new Date()
  when.setDate(when.getDate() + 1)
  // 界面格式是「11 月 27 日 周五」（数字与汉字之间有空格），断言要按它来
  const tomorrow = `${when.getMonth() + 1} 月 ${when.getDate()} 日`
  const occ = await evalIn(pet, `window.api.occasionDebugRemember('明天下午3点我要去面试')`)
  check('事件被记下（抽取路径）', Array.isArray(occ) && occ.length === 1, JSON.stringify(occ?.[0]?.text))
  const noted = await evalIn(pet, `window.api.dailyDebugRemember('今天花了10块')`)
  check('日常记事被记下（抽取路径）', noted === true)

  // ---- 打开设置 ----
  await evalIn(pet, 'window.api.openSettings()')
  await sleep(2200)
  list = await fetchTargets()
  const settings = list.find((t) => t.url.includes('/settings/'))
  check('设置窗口打开', !!settings)

  const occList = await evalIn(settings, readSection('它记得的事'))
  check('设置里有「它记得的事」分区', Array.isArray(occList), JSON.stringify(occList))
  check('事件条目显示可读日期', Array.isArray(occList) && occList.some((t) => t.includes(tomorrow)), JSON.stringify(occList))
  check('事件条目带原话', Array.isArray(occList) && occList.some((t) => t.includes('面试')), JSON.stringify(occList))

  const dayList = await evalIn(settings, readSection('今天记下的'))
  check('设置里有「今天记下的」分区', Array.isArray(dayList), JSON.stringify(dayList))
  check('日常条目可见', Array.isArray(dayList) && dayList.some((t) => t.includes('花了10块')), JSON.stringify(dayList))

  // ---- 点 × 删除 ----
  const clicked = await evalIn(settings, clickDel('面试'))
  check('能点到事件的删除按钮', clicked === 'clicked', clicked)
  await sleep(900)
  const occAfter = await evalIn(settings, readSection('它记得的事'))
  check('划掉后事件不再出现', Array.isArray(occAfter) && !occAfter.some((t) => t.includes('面试')), JSON.stringify(occAfter))

  const clickedNote = await evalIn(settings, clickDel('花了10块'))
  check('能点到记事的删除按钮', clickedNote === 'clicked', clickedNote)
  await sleep(900)
  const dayAfter = await evalIn(settings, readSection('今天记下的'))
  check('删除后记事不再出现', Array.isArray(dayAfter) && !dayAfter.some((t) => t.includes('花了10块')), JSON.stringify(dayAfter))

  // ---- 笔记本：只放「它记得的事」，不放带数字的日常 ----
  await evalIn(pet, `window.api.occasionDebugRemember('下周五我要搬家')`)
  await evalIn(pet, `window.api.dailyDebugRemember('今天喝了3杯咖啡')`)
  await evalIn(pet, 'window.api.openNotebook()')
  await sleep(2200)
  list = await fetchTargets()
  const notebook = list.find((t) => t.url.includes('/notebook/'))
  const nbText = notebook ? await evalIn(notebook, `document.body.innerText`) : ''
  check('笔记本里有「它记得的事」', String(nbText).includes('它记得的事'), '')
  check('笔记本里有搬家这件事', String(nbText).includes('搬家'), '')
  // 日记的规矩：说感受，不说数据
  check('笔记本里不出现「3杯咖啡」', !String(nbText).includes('3杯咖啡'), '')
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
console.log(`\n[remember-ui] ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
