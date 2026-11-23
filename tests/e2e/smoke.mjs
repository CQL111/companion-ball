// tests/e2e/smoke.mjs - 功能测试（端到端冒烟）
// 真实启动 Electron，经 CDP 驱动各窗口，断言渲染结果与主进程日志。
// 用法：
//   npm run build && node tests/e2e/smoke.mjs
// 退出码 0 = 通过；非 0 = 失败（会把失败项和日志尾部打印出来）
//
// 设计约束：
// - 不依赖第三方包（Node 22 自带 fetch / WebSocket）
// - 使用独立 --user-data-dir，绝不触碰用户真实配置
// - 不调用线上 AI（只在配置了 DEEPSEEK_API_KEY 时做一次真实对话冒烟）

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9333
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-'))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchTargets() {
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
  let id = 0
  const pending = new Map()
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
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  return res.result?.result?.value ?? res.result?.exceptionDetails?.text
}

function readLog() {
  const dir = path.join(TMP, 'logs')
  if (!fs.existsSync(dir)) return ''
  const file = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort().pop()
  return file ? fs.readFileSync(path.join(dir, file), 'utf8') : ''
}

// 渲染端初始化是异步的（读配置、构建 React 树），断言必须轮询而不是抢跑
async function waitFor(target, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evalIn(target, expression)
    if (last) return last
    await sleep(300)
  }
  return last
}

/** 从源码读取当前协议版本：改版本号时 e2e 会自动跟上，不会因为 agree 页卡住 */
function currentAgreementVersion() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src/main/windows.ts'), 'utf8')
    const m = /AGREEMENT_VERSION = (\d+)/.exec(src)
    return m ? Number(m[1]) : 1
  } catch {
    return 1
  }
}

function seedConfig() {
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify(
      {
        consentVersion: currentAgreementVersion(),
        persona: 'cat',
        position: { x: 1200, y: 650 },
        animations: true,
        sound: false,
      },
      null,
      2,
    ),
  )
}

let child
try {
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
    console.error('❌ 未找到构建产物，请先运行 npm run build')
    process.exit(1)
  }
  if (!fs.existsSync(ELECTRON)) {
    console.error('❌ 未找到 Electron 可执行文件，请先 npm install')
    process.exit(1)
  }

  console.log('\n[e2e] 启动应用（隔离 userData）')
  seedConfig()
  child = spawn(ELECTRON, ['.', '--hidden', `--user-data-dir=${TMP}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env },
  })

  let list = await fetchTargets()
  check('应用启动并暴露 CDP 目标', list.length > 0, `${list.length} 个窗口`)

  const pet = list.find((t) => t.url.includes('/pet/'))
  check('团子猫窗口已加载', !!pet)
  if (pet) {
    // v0.6.0：角色由精灵图集渲染到 canvas，检查画布真的有像素
    const hasPixels = await waitFor(pet, `(() => { const c = document.querySelector('#pet-canvas'); if (!c) return 0; const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n; })()`)
    check('宠物窗口从图集渲染出角色', Number(hasPixels) > 500, String(hasPixels) + ' px')
    const clipName = await waitFor(pet, `document.querySelector('#pet-canvas')?.dataset.clip || ''`)
    check('渲染器报告当前动作', ['idle','tap','sleep','wake','stretch','groom','annoyed','dizzy','walk','climb','hang','fall','land','held'].includes(String(clipName)), String(clipName))
    const menuCount = await waitFor(pet, `document.querySelectorAll('.menu-item').length || 0`)
    check('宠物窗口菜单入口存在', menuCount === 2)
    // S1：状态机渲染出 data-mood，且气泡节点存在
    const petMood = await waitFor(pet, `document.querySelector('#ball-inner')?.getAttribute('data-mood') || ''`)
    check('宠物窗口渲染出情绪状态 data-mood', ['neutral','smile','curious','doze','sleep','annoyed','dizzy'].includes(String(petMood)), String(petMood))
    check('气泡层节点存在', !!(await evalIn(pet, `!!document.querySelector('#pet-bubble')`)))
    // v0.5.0：桌面上的身体
    const locoState = await waitFor(pet, `document.querySelector('#ball')?.getAttribute('data-loco') || ''`)
    check('运动状态 data-loco 已渲染', ['idle','walk','climb','hang','fall','land','held'].includes(String(locoState)), String(locoState))
    const pos = await waitFor(
      pet,
      `/translate\\(1200px, 650px\\)/.test(document.querySelector('#ball')?.style.transform || '') && document.querySelector('#ball').style.transform`,
    )
    check('宠物窗口已应用位置 transform', !!pos, String(pos))

    // 回归：托盘「重置位置」必须把猫移回默认位置（不能 setPosition 全屏窗口）
    await evalIn(pet, 'window.api.debugResetBall()')
    await sleep(900)
    const resetPos = await evalIn(
      pet,
      `(() => {
        const r = document.querySelector('#ball').getBoundingClientRect()
        return { x: Math.round(r.left), y: Math.round(r.top), vw: innerWidth, vh: innerHeight }
      })()`,
    )
    const expectX = resetPos.vw - 80 - 40
    const expectY = resetPos.vh - 80 - 40
    check(
      '重置位置回到右下角默认位置',
      Math.abs(resetPos.x - expectX) < 8 && Math.abs(resetPos.y - expectY) < 8,
      `${resetPos.x},${resetPos.y} vs ${expectX},${expectY}`,
    )

    await evalIn(pet, 'window.api.openSettings()')
    await sleep(2000)
    await evalIn(pet, 'window.api.openAiInput()')
    await sleep(2000)
  }

  list = await fetchTargets()
  const settings = list.find((t) => t.url.includes('/settings/'))
  const chat = list.find((t) => t.url.includes('/chat/'))
  const settingsReady = settings ? await waitFor(settings, `!!document.querySelector('.settings h1')`) : false
  const chatReady = chat ? await waitFor(chat, `!!document.querySelector('.ai-title')`) : false
  check('设置窗口打开并完成 React 渲染', !!settings && !!settingsReady)
  check('对话浮窗打开并完成 React 渲染', !!chat && !!chatReady)

  // S2：笔记本窗口 + 记忆 / 备份接口
  if (pet) {
    await evalIn(pet, 'window.api.openNotebook()')
    await sleep(2000)
  }
  list = await fetchTargets()
  const notebook = list.find((t) => t.url.includes('/notebook/'))
  const nbReady = notebook ? await waitFor(notebook, `!!document.querySelector('.notebook h1')`) : false
  check('笔记本窗口打开并完成 React 渲染', !!notebook && !!nbReady)
  if (pet) {
    const mem = await evalIn(pet, 'window.api.getMemories()')
    check('记忆接口可用且默认开启', !!mem && mem.enabled === true && Array.isArray(mem.memories), JSON.stringify(mem && mem.max))
    const nb = await evalIn(pet, 'window.api.getNotebookView()')
    check('笔记本接口可用', !!nb && Array.isArray(nb.entries))
  }

  if (chat) {
    const hasKey = !!(process.env.DEEPSEEK_API_KEY || fs.existsSync(path.join(ROOT, '.env')))
    if (hasKey) {
      console.log('\n[e2e] 发送真实消息（使用本机 .env 的 Key）')
      await evalIn(
        chat,
        `(() => { const ta = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(ta,'你好'); ta.dispatchEvent(new Event('input',{bubbles:true})) })()`,
      )
      await evalIn(chat, `document.querySelector('.ai-submit').click()`)
      let answered = false
      for (let i = 0; i < 20 && !answered; i++) {
        await sleep(1000)
        answered = !!(await evalIn(chat, `!!document.querySelector('.msg.assistant')`))
      }
      check('对话返回并渲染助手消息', answered)
    } else {
      console.log('\n[e2e] 跳过真实对话（未配置 Key）')
    }
  }

  // 全局快捷键在任何实例下都不保证可用（会被其他软件占用），
  // 只允许作为 optional 项出现在自检结果里。
  await sleep(1000)
  const log = readLog()
  const allowed = [/\[WARN\] \[shortcut\] Ctrl\+Alt\+F 已被其他应用占用/, /\[WARN\] \[selfCheck\] shortcut Ctrl\+Alt\+F not registered/, /\[WARN\] \[selfCheck\] failed: shortcut \(optional\)/]
  const errors = log
    .split('\n')
    .filter((l) => /\[(ERROR|CRITICAL)\]/.test(l) || (/\[WARN\]/.test(l) && !allowed.some((re) => re.test(l))))
  check('主进程日志无 error / critical / 意外 warn', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 200))
} catch (e) {
  check('e2e 执行未抛异常', false, String(e?.message || e))
} finally {
  if (child) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
  // Windows 下 Electron 会派生多个进程
  try {
    const { execSync } = await import('node:child_process')
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='electron.exe'\\" | Where-Object { $_.CommandLine -like '*${TMP.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
      { stdio: 'ignore' },
    )
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n[e2e] ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
