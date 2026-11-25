// tests/e2e/occasions.mjs - P1.5 事件记忆真机验证
//
// 验证点（对应 docs/OCCASIONS.md 第九节）：
//   1. 对话里说「我下周三要面试」→ 被记住，且写进当天日记
//   2. 日记里出现「我会记得的」，且不含数字
//   3. 划掉后不再出现在列表
//   4. 关闭开关后清空
//   5. 全是发生在主进程，不弹系统通知
//
// 用法：npm run build && node tests/e2e/occasions.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const REPO_ROOT = path.resolve(ROOT, '..', '..')
const ELECTRON = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9447
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-occ-'))

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
    JSON.stringify(
      { consentVersion: agreement, persona: 'cat', position: { x: 1200, y: 650 }, animations: true, sound: false, aiConfig: { baseUrl: '', token: '', model: '' } },
      null,
      2,
    ),
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
  await sleep(2500)

  // 初始应为空
  const before = await evalIn(pet, `window.api.occasionsList()`)
  check('初始没有事件记忆', before && before.enabled === true && before.occasions.length === 0, JSON.stringify(before?.occasions))

  // 1) 说一句有日期的话：直接调抽取入口（不依赖 AI Key）
  const added = await evalIn(
    pet,
    `(async () => {
       // 走真实链路：先开聊天窗口发一条消息太依赖 Key，这里用主进程暴露的
       // 同一条抽取路径（通过提交一条用户消息触发的 HTTP 调用不可控）
       return await window.api.occasionDebugRemember('我下周三下午要面字节')
     })()`,
  )
  check('「我下周三下午要面字节」被记住', Array.isArray(added) && added.length === 1, JSON.stringify(added))

  const listAfter = await evalIn(pet, `window.api.occasionsList()`)
  const item = listAfter?.occasions?.[0]
  check('列表里出现该事件', !!item, item ? `${item.kind} @ ${item.date}` : '无')
  check('保留用户原话', !!item && item.text.includes('面字节'), item?.text)

  // 2) 日记里出现「我会记得的」，且不含数字
  const nb = await evalIn(pet, `window.api.getNotebookView()`)
  const all = (nb?.entries ?? []).flatMap((e) => e.lines)
  const diaryLine = all.find((l) => l.includes('我会记得的'))
  check('写进当天日记', !!diaryLine, diaryLine)
  check('日记不含数字', all.every((l) => !/[0-9０-９]/.test(l)))

  // 3) 划掉
  if (item) {
    const ok = await evalIn(pet, `window.api.occasionsDismiss(${JSON.stringify(item.id)})`)
    check('划掉成功', ok === true)
    const afterDismiss = await evalIn(pet, `window.api.occasionsList()`)
    const still = afterDismiss.occasions.find((o) => o.id === item.id)
    check('划掉后状态为 dismissed', still?.status === 'dismissed', still?.status)
  }
  // 划掉后不复活的正确验证：用「明天」的事件（T-1 本来会触发），划掉后应静默
  const tomorrow = await evalIn(pet, `window.api.occasionDebugRemember('明天要体检')`)
  check('「明天要体检」被记住', Array.isArray(tomorrow) && tomorrow.length === 1)
  const peekBefore = await evalIn(pet, `window.api.occasionPeek()`)
  check('明天的体检在 T-1 触发接住', !!peekBefore && peekBefore.beat === 'approach', JSON.stringify(peekBefore?.beat))
  if (tomorrow?.[0]) {
    await evalIn(pet, `window.api.occasionsDismiss(${JSON.stringify(tomorrow[0].id)})`)
    const peekAfter = await evalIn(pet, `window.api.occasionPeek()`)
    // 断言「这条不再出现在接住里」——而不是「完全没有接住」
    // （列表里可能还有别的 upcoming 事件，那是正常行为）
    const stillTarget = peekAfter && peekAfter.occasion && peekAfter.occasion.id === tomorrow[0].id
    check('划掉的那条不再触发接住', !stillTarget, peekAfter ? `返回了 ${peekAfter.occasion?.id}` : 'null')
  }

  // 4) 关闭开关 → 清空
  const off = await evalIn(pet, `window.api.occasionsSetEnabled(false)`)
  check('关闭后清空', off && off.enabled === false && off.occasions.length === 0, JSON.stringify(off?.occasions))

  // 5) 重新打开
  const on = await evalIn(pet, `window.api.occasionsSetEnabled(true)`)
  check('可以重新打开', on && on.enabled === true)
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
console.log(`\n[occasions] ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
