#!/usr/bin/env node
// scripts/mock-bottle-server.mjs - 本地许愿瓶服务端（零依赖，纯内存）
//
// 用途：不装 wrangler、不建 D1，直接在本地跑通客户端全流程。
// 行为与 server/src/index.ts 保持一致（同样的路径、错误码、限流与举报隐藏），
// 区别只有两点：数据存在内存里（重启清空）、内容策略固定为 open。
//
// 用法：
//   node scripts/mock-bottle-server.mjs              # 默认端口 8787，预置 3 张纸条
//   node scripts/mock-bottle-server.mjs --port 9000  # 换端口
//   node scripts/mock-bottle-server.mjs --seed 10    # 预置更多纸条
//   node scripts/mock-bottle-server.mjs --paused     # 模拟紧急停机（写接口 503）
//
// 客户端设置：设置 → 许愿瓶 → 服务端地址填 http://127.0.0.1:8787

import http from 'node:http'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const seedArg = args.indexOf('--seed')
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8787
const SEED = seedArg >= 0 ? Number(args[seedArg + 1]) : 3
const PAUSED = args.includes('--paused')

const BOTTLE_MAX_LENGTH = 60
const REPLY_MAX_LENGTH = 60
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const DAILY_BOTTLE_LIMIT = 3
const DAILY_REPLY_LIMIT = 10
const MAX_PICKS = 3

// ---------- 内存数据 ----------
const bottles = new Map() // id -> bottle
const replies = new Map() // id -> reply
const picks = new Set() // `${bottleId}:${tokenHash}`
const revoked = new Set()

const hashToken = (token) => crypto.createHash('sha256').update('companion-ball:' + token).digest('hex')
const randomId = () => crypto.randomBytes(16).toString('hex')

const ADJ = ['夜里的', '路过的', '安静的', '早起的', '走神的', '发呆的', '慢吞吞的', '突然的']
const NOUN = ['橘子', '路灯', '猫', '水杯', '窗台', '雨伞', '台灯', '影子', '枕头', '台阶']
const randomAlias = () => ADJ[Math.floor(Math.random() * ADJ.length)] + NOUN[Math.floor(Math.random() * NOUN.length)]

function poolFor(now, offsetMinutes) {
  const h = new Date(now + offsetMinutes * 60000).getUTCHours()
  if (h >= 22 || h < 5) return 'night'
  if (h < 11) return 'morning'
  if (h < 18) return 'day'
  return 'evening'
}

function dayStart(now, offsetMinutes) {
  const local = now + offsetMinutes * 60000
  return local - (local % 86400000) - offsetMinutes * 60000
}

// 与客户端 open 策略一致：只做非空与长度
function checkText(raw, max) {
  const cleaned = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return { ok: false, reason: 'EMPTY' }
  if (cleaned.length > max) return { ok: false, reason: 'TOO_LONG' }
  return { ok: true, cleaned }
}

// ---------- 预置测试纸条 ----------
const SEEDS = [
  '今天加班到很晚，有点撑不住',
  '窗外在下雨，我在等它停',
  '刚才想起一件很久以前的事',
  '明天要早起，但睡不着',
  '今天遇到一只很凶的橘猫',
  '其实我没什么想说的，就是想放点什么',
  '在地铁上站了四十分钟，突然很想哭',
  '把今天撑过去了，算不算厉害',
  '有点想回家',
  '刚吃完一碗面，很满足',
]
for (let i = 0; i < SEED; i++) {
  const id = randomId()
  const now = Date.now() - i * 3600_000
  bottles.set(id, {
    id,
    pool: poolFor(now, 480),
    body: SEEDS[i % SEEDS.length],
    authorToken: hashToken('seed-' + i),
    alias: randomAlias(),
    createdAt: now,
    expiresAt: now + TTL_MS,
    picks: 0,
    replyId: null,
    hidden: false,
  })
}

// ---------- HTTP ----------
function json(res, body, status = 200) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(payload)
}
const err = (res, code, status = 400) => json(res, { ok: false, error: code }, status)

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

const countToday = (token, since, table) => {
  const list = table === 'bottles' ? [...bottles.values()] : [...replies.values()]
  return list.filter((r) => r.authorToken === token && r.createdAt >= since).length
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') return err(res, 'METHOD_NOT_ALLOWED', 405)

  const token = req.headers['x-device-token'] || ''
  if (!token || token.length < 16) return err(res, 'BAD_TOKEN', 401)
  const tokenHash = hashToken(token)
  if (revoked.has(tokenHash)) return err(res, 'REVOKED', 403)

  const url = new URL(req.url, 'http://localhost')
  const body = await readBody(req)
  const now = Date.now()
  const offset = Number.isFinite(Number(body.utcOffsetMinutes))
    ? Math.max(-840, Math.min(840, Math.round(Number(body.utcOffsetMinutes))))
    : 0

  if (url.pathname === '/v1/health') return json(res, { ok: true, paused: PAUSED })
  if (PAUSED) return err(res, 'SERVICE_PAUSED', 503)

  switch (url.pathname) {
    case '/v1/bottle': {
      const check = checkText(body.body, BOTTLE_MAX_LENGTH)
      if (!check.ok) return json(res, { ok: false, error: check.reason }, 200)
      if (countToday(tokenHash, dayStart(now, offset), 'bottles') >= DAILY_BOTTLE_LIMIT) {
        return err(res, 'DAILY_LIMIT', 429)
      }
      const id = randomId()
      const alias = randomAlias()
      bottles.set(id, {
        id,
        pool: poolFor(now, offset),
        body: check.cleaned,
        authorToken: tokenHash,
        alias,
        createdAt: now,
        expiresAt: now + TTL_MS,
        picks: 0,
        replyId: null,
        hidden: false,
      })
      return json(res, { ok: true, id, expiresAt: now + TTL_MS, alias })
    }

    case '/v1/bottle/pick': {
      const pool = poolFor(now, offset)
      const candidates = [...bottles.values()].filter(
        (b) =>
          b.pool === pool &&
          b.expiresAt > now &&
          !b.hidden &&
          !b.replyId &&
          b.picks < MAX_PICKS &&
          b.authorToken !== tokenHash &&
          !picks.has(`${b.id}:${tokenHash}`),
      )
      if (!candidates.length) return json(res, { ok: true, bottle: null })
      const picked = candidates[Math.floor(Math.random() * candidates.length)]
      picks.add(`${picked.id}:${tokenHash}`)
      picked.picks += 1
      return json(res, { ok: true, bottle: { id: picked.id, body: picked.body, alias: picked.alias } })
    }

    case '/v1/bottle/reply': {
      const bottleId = String(body.bottleId || '')
      const check = checkText(body.body, REPLY_MAX_LENGTH)
      if (!check.ok) return json(res, { ok: false, error: check.reason }, 200)
      if (countToday(tokenHash, dayStart(now, offset), 'replies') >= DAILY_REPLY_LIMIT) {
        return err(res, 'DAILY_LIMIT', 429)
      }
      const bottle = bottles.get(bottleId)
      if (!bottle || bottle.hidden) return err(res, 'NOT_FOUND', 404)
      if (bottle.replyId) return err(res, 'ALREADY_REPLIED', 409)
      if (bottle.authorToken === tokenHash) return err(res, 'SELF_REPLY', 400)
      const replyId = randomId()
      replies.set(replyId, {
        id: replyId,
        bottleId,
        body: check.cleaned,
        authorToken: tokenHash,
        alias: randomAlias(),
        createdAt: now,
        hidden: false,
      })
      bottle.replyId = replyId
      return json(res, { ok: true, replyId })
    }

    case '/v1/bottle/inbox': {
      const list = [...bottles.values()]
        .filter((b) => b.authorToken === tokenHash && b.replyId && !b.hidden)
        .map((b) => {
          const r = replies.get(b.replyId)
          if (!r || r.hidden) return null
          return { bottleId: b.id, bottleBody: b.body, replyBody: r.body, replyAlias: r.alias, createdAt: r.createdAt }
        })
        .filter(Boolean)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20)
      return json(res, { ok: true, replies: list })
    }

    case '/v1/report': {
      const bottleId = typeof body.bottleId === 'string' ? body.bottleId : null
      const replyId = typeof body.replyId === 'string' ? body.replyId : null
      if (!bottleId && !replyId) return err(res, 'NO_TARGET')
      if (bottleId && bottles.has(bottleId)) bottles.get(bottleId).hidden = true
      if (replyId && replies.has(replyId)) replies.get(replyId).hidden = true
      return json(res, { ok: true })
    }

    default:
      return err(res, 'NOT_FOUND', 404)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`许愿瓶 mock 服务端已启动: http://127.0.0.1:${PORT}`)
  console.log(`  预置纸条: ${SEED} 张${PAUSED ? '（当前处于紧急停机状态，写接口返回 503）' : ''}`)
  console.log('  在客户端「设置 → 许愿瓶」填入上面的地址，然后开启许愿瓶')
  console.log('  按 Ctrl+C 停止（数据只在内存里，重启清空）')
})

process.on('SIGINT', () => {
  console.log('\n已停止')
  process.exit(0)
})
