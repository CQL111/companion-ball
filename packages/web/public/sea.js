// sea.js - 前台的共享逻辑（无框架，原生 JS）
//
// 前台只有三件事要做：拉橱窗、静读、拉新闻。
// 不需要构建工具，也不需要框架——页面是给别人看海的，不是给别人体验前端的。

const POOLS = [
  { key: 'night', label: '深夜' },
  { key: 'morning', label: '清晨' },
  { key: 'day', label: '白天' },
  { key: 'evening', label: '傍晚' },
]

function localPool() {
  const h = new Date().getHours()
  if (h >= 22 || h < 5) return 'night'
  if (h < 11) return 'morning'
  if (h < 18) return 'day'
  return 'evening'
}

async function fetchGallery(pool) {
  const res = await fetch(`/v1/gallery?pool=${encodeURIComponent(pool)}`)
  if (!res.ok) {
    if (res.status === 503) return { items: [], closed: true }
    throw new Error('gallery')
  }
  return res.json()
}

/* ---------- 静读模式 ---------- */

function createReader(items) {
  let index = 0
  const el = document.createElement('div')
  el.className = 'reader'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.innerHTML = `
    <button class="close" aria-label="关闭">×</button>
    <div class="card">
      <p class="text"></p>
      <p class="by"></p>
    </div>
    <div class="nav">
      <button data-nav="prev">← 上一张</button>
      <button data-nav="next">下一张 →</button>
    </div>
    <div class="report"><button data-report>举报</button></div>
  `
  document.body.appendChild(el)

  const textEl = el.querySelector('.text')
  const byEl = el.querySelector('.by')
  const prevBtn = el.querySelector('[data-nav="prev"]')
  const nextBtn = el.querySelector('[data-nav="next"]')

  function paint() {
    const it = items[index]
    if (!it) return
    textEl.textContent = it.body
    const pool = POOLS.find((p) => p.key === it.pool)
    byEl.textContent = `—— ${it.alias}${pool ? ' · ' + pool.label : ''}`
    prevBtn.disabled = index <= 0
    nextBtn.disabled = index >= items.length - 1
  }

  function open(i) {
    index = Math.max(0, Math.min(items.length - 1, i))
    paint()
    el.classList.add('open')
    // 不进浏览器历史：关闭后回到原位置
    history.replaceState(history.state, '', location.href)
    document.body.style.overflow = 'hidden'
  }

  function close() {
    el.classList.remove('open')
    document.body.style.overflow = ''
  }

  el.addEventListener('click', (e) => {
    const t = e.target
    if (t === el) close()
    if (t.closest('.close')) close()
    if (t.closest('[data-nav="prev"]')) {
      index--
      paint()
    }
    if (t.closest('[data-nav="next"]')) {
      index++
      paint()
    }
    if (t.closest('[data-report]')) reportCurrent()
  })

  async function reportCurrent() {
    const it = items[index]
    if (!it) return
    if (!confirm('举报后这条会立刻下架。确定吗？')) return
    try {
      await fetch('/v1/gallery/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: it.id, reason: 'other' }),
      })
      items.splice(index, 1)
      if (!items.length) close()
      else open(Math.min(index, items.length - 1))
    } catch {
      /* 举报失败不打断阅读 */
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!el.classList.contains('open')) return
    if (e.key === 'Escape') close()
    if (e.key === 'ArrowLeft' && index > 0) {
      index--
      paint()
    }
    if (e.key === 'ArrowRight' && index < items.length - 1) {
      index++
      paint()
    }
  })

  return { open, close }
}

/* ---------- 橱窗渲染 ---------- */

function renderGallery(root, tideNav, data, reader) {
  root.innerHTML = ''
  if (data.closed) {
    root.innerHTML = '<p class="empty">窗口暂时关着。<br>海面上有一点动静，过一会儿再来。</p>'
    return
  }
  if (!data.items.length) {
    root.innerHTML = '<p class="empty">此刻这片海很安静。<br>你是最早来的人之一。</p>'
    return
  }
  data.items.forEach((it, i) => {
    const btn = document.createElement('button')
    btn.className = 'bottle'
    const text = document.createElement('div')
    text.className = 'text'
    text.textContent = it.body
    const by = document.createElement('div')
    by.className = 'by'
    by.textContent = `—— ${it.alias}`
    btn.append(text, by)
    btn.addEventListener('click', () => reader.open(i))
    root.appendChild(btn)
  })
  void tideNav
}

/* ---------- 启动 ---------- */

function initGallery() {
  const root = document.getElementById('bottles')
  const tideNav = document.getElementById('tide-nav')
  if (!root || !tideNav) return

  let pool = new URLSearchParams(location.search).get('pool') || localPool()
  let reader = createReader([])

  tideNav.innerHTML = POOLS.map(
    (p) => `<button data-pool="${p.key}" class="${p.key === pool ? 'on' : ''}">${p.label}</button>`,
  ).join('')

  async function load(p) {
    pool = p
    for (const b of tideNav.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.pool === p)
    }
    root.innerHTML = '<p class="status">正在看海…</p>'
    try {
      const data = await fetchGallery(p)
      reader = createReader(data.items)
      renderGallery(root, tideNav, data, reader)
      // 计数：只 +1，不记录任何个体
      void fetch('/v1/gallery/view', { method: 'POST' }).catch(() => {})
    } catch {
      root.innerHTML = '<p class="empty">海面不太平静，等会儿再看。</p>'
    }
    // 把当前潮汐写进地址，方便分享「这片海」
    const u = new URL(location.href)
    u.searchParams.set('pool', p)
    history.replaceState(history.state, '', u)
  }

  tideNav.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pool]')
    if (b) void load(b.dataset.pool)
  })

  void load(pool)
}

initGallery()
