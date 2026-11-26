import { useCallback, useEffect, useState } from 'react'
import type { BottleReplyView, BottleStatusView } from '../../shared/types'

type Phase = 'write' | 'sent' | 'reading' | 'replied'

interface PickedBottle {
  id: string
  body: string
  alias: string
}

const MAX = 60

export default function App(): React.ReactElement {
  const [status, setStatus] = useState<BottleStatusView | null>(null)
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>('write')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: '' | 'ok' | 'err'; text: string }>({ kind: '', text: '' })
  const [picked, setPicked] = useState<PickedBottle | null>(null)
  const [reply, setReply] = useState('')
  const [waiting, setWaiting] = useState(false)
  /** 这张纸条是否允许被网页橱窗展示（逐条选，默认不公开，不记忆） */
  const [requestPublic, setRequestPublic] = useState(false)
  /** 刚扔出的那张是否已提交公开审核 */
  const [sentPublic, setSentPublic] = useState(false)
  /** 收到的回信（只读列表；点「收下」才写进日记） */
  const [inbox, setInbox] = useState<BottleReplyView[] | null>(null)
  const [inboxBusy, setInboxBusy] = useState(false)
  const [keptCount, setKeptCount] = useState(0)

  const load = useCallback(async () => {
    try {
      setStatus(await window.api.bottleStatus())
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    window.logger.info('mail.load', 'start')
    void load()
  }, [load])

  const enable = async (): Promise<void> => {
    const view = await window.api.bottleToggle({ enabled: true })
    setStatus(view)
    window.logger.info('mail.enable', 'on')
  }

  const throwIt = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMsg({ kind: '', text: '' })
    try {
      const r = await window.api.bottleThrow(text, requestPublic)
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.errorText || '放不进去' })
        return
      }
      setSentPublic(r.data?.publicPending === true)
      setText('')
      setRequestPublic(false)
      setPhase('sent')
      window.logger.info('mail.throw', 'ok')
    } finally {
      setBusy(false)
    }
  }

  /** 打开收信列表（只读，不会重复写日记） */
  const openInbox = async (): Promise<void> => {
    setInboxBusy(true)
    setMsg({ kind: '', text: '' })
    setKeptCount(0)
    try {
      const r = await window.api.bottleInbox()
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.errorText || '海面不太平静' })
        return
      }
      const list = r.data || []
      setInbox(list)
      if (!list.length) setMsg({ kind: '', text: '还没有人回你。再等等。' })
    } finally {
      setInboxBusy(false)
    }
  }

  /** 把回信收进日记 */
  const keepAll = async (): Promise<void> => {
    if (!inbox?.length) return
    setInboxBusy(true)
    try {
      const n = await window.api.bottleInboxKeep(inbox)
      setKeptCount(n)
      if (n) setMsg({ kind: 'ok', text: `收下了 ${n} 封，写进今天的日记了。` })
      else setMsg({ kind: '', text: '这些已经在日记里了。' })
    } finally {
      setInboxBusy(false)
    }
  }

  /** 猫出门看看有没有纸条 */
  const goPick = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setWaiting(true)
    setMsg({ kind: '', text: '' })
    try {
      const r = await window.api.bottlePick(true)
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.errorText || '海面不太平静' })
        return
      }
      if (!r.data) {
        setMsg({ kind: 'ok', text: '猫空手回来了。再等等吧。' })
        return
      }
      setPicked(r.data)
      setPhase('reading')
      window.logger.info('mail.pick', 'got one')
    } finally {
      setWaiting(false)
      setBusy(false)
    }
  }

  const sendReply = async (): Promise<void> => {
    if (busy || !picked) return
    setBusy(true)
    try {
      const r = await window.api.bottleReply(picked.id, reply)
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.errorText || '没送出去' })
        return
      }
      setReply('')
      setPicked(null)
      setPhase('replied')
      window.logger.info('mail.reply', 'ok')
    } finally {
      setBusy(false)
    }
  }

  const reportIt = async (): Promise<void> => {
    if (!picked) return
    await window.api.bottleReport({ bottleId: picked.id }, 'other')
    setPicked(null)
    setPhase('write')
    setMsg({ kind: 'ok', text: '已举报，这张不会给别人看到了。' })
  }

  // ---------- 未开启 ----------
  if (!status || !status.enabled) {
    // 服务端还没部署时，按钮不可用；明确告诉用户是「服务未上线」而不是「你操作错了」
    const available = !!status?.endpoint
    return (
      <div className="mail">
        <header className="mail-header">
          <h1>许愿瓶</h1>
          <p className="mail-sub">把一句话放进瓶里，它会漂给另一个也醒着的人。</p>
        </header>

        <section className="mail-card">
          <ul className="mail-points">
            <li>纸条会离开这台电脑，发送到服务器</li>
            <li>对方只能看到随机生成的代号，看不到你是谁</li>
            <li>不能私聊、不能追问；七天后没人捡，就沉海了</li>
            <li>你可以随时在这里关掉它</li>
          </ul>

          {!available && (
            <p className="mail-hint mail-hint-warn">
              猫邮局还没开门：这个版本尚未配置服务端地址。
              功能代码已就绪，等服务器部署后即可使用。
            </p>
          )}

          <button className="btn primary" onClick={() => void enable()} disabled={!available}>
            {available ? '我知道，开启许愿瓶' : '尚未开放'}
          </button>
        </section>
      </div>
    )
  }

  // ---------- 已开启 ----------
  return (
    <div className="mail">
      <header className="mail-header">
        <h1>许愿瓶</h1>
        <p className="mail-sub">
          今天已经放了 {status.thrownToday} / {status.dailyLimit} 张
        </p>
      </header>

      {msg.text && <div className={`mail-msg ${msg.kind}`}>{msg.text}</div>}

      {phase === 'write' && (
        <section className="mail-card">
          <textarea
            value={text}
            maxLength={MAX}
            rows={4}
            placeholder="写点什么，比如：今天加班到很晚，有点撑不住"
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
          <label className="mail-public">
            <input
              type="checkbox"
              checked={requestPublic}
              onChange={(e) => setRequestPublic(e.target.checked)}
              disabled={busy}
            />
            <span>
              可以让别人在海边看到
              <em>（只有这张；不带名字，审核通过后出现在网页上）</em>
            </span>
          </label>
          <div className="mail-row">
            <span className="mail-count">
              {text.length}/{MAX}
            </span>
            <button className="btn primary" onClick={() => void throwIt()} disabled={busy || !text.trim()}>
              放进海里
            </button>
          </div>
          <hr className="mail-sep" />
          <div className="mail-row">
            <button className="btn" onClick={() => void goPick()} disabled={busy}>
              {waiting ? '猫出门了…' : '让猫出去看看'}
            </button>
            <button className="btn ghost" onClick={() => void openInbox()} disabled={inboxBusy}>
              {inbox === null ? '收到的回信' : '重新看看回信'}
            </button>
          </div>
        </section>
      )}

      {/* 收信列表：只读；点「收下」才写进日记 */}
      {inbox !== null && phase === 'write' && (
        <section className="mail-card">
          <div className="mail-row">
            <span className="mail-from">别人回你的话</span>
            <span className="grow" />
            {inbox.length > 0 && (
              <button className="btn sm" onClick={() => void keepAll()} disabled={inboxBusy}>
                {keptCount ? '已经收下了' : '收下，记进日记'}
              </button>
            )}
            <button className="btn ghost sm" onClick={() => setInbox(null)}>
              收起
            </button>
          </div>

          {inbox.length === 0 ? (
            <p className="mail-hint" style={{ marginTop: 10 }}>
              还没有人回你。纸条可能还在漂着，也可能已经沉海了。
            </p>
          ) : (
            <ul className="mail-inbox">
              {inbox.map((r) => (
                <li key={`${r.bottleId}-${r.createdAt}`}>
                  <p className="mail-quote mail-quote-sm">{r.replyBody}</p>
                  <p className="mail-hint">
                    —— {r.replyAlias}，回的是你写的「{r.bottleBody}」
                  </p>
                </li>
              ))}
            </ul>
          )}

          <p className="mail-hint">回了就断了：你没法再联系 ta，ta 也不会知道你收到了。</p>
        </section>
      )}

      {phase === 'sent' && (
        <section className="mail-card center">
          <p className="mail-big">已经放进海里了。</p>
          <p className="mail-hint">它可能漂到很远的地方，也可能没人捡到。</p>
          {sentPublic && (
            <p className="mail-hint">
              也会有人在海边的窗口读到它——审核通过后，它会出现在网页上，但没有你的名字。
            </p>
          )}
          <div className="mail-row center">
            <button className="btn" onClick={() => setPhase('write')}>
              再写一张
            </button>
            <button className="btn primary" onClick={() => void goPick()} disabled={busy}>
              让猫出去看看
            </button>
          </div>
        </section>
      )}

      {phase === 'reading' && picked && (
        <section className="mail-card">
          <p className="mail-from">来自「{picked.alias}」</p>
          <blockquote className="mail-quote">{picked.body}</blockquote>
          <textarea
            value={reply}
            maxLength={MAX}
            rows={3}
            placeholder="可以悄悄回一句（对方不会知道你是谁，你也收不到后续）"
            onChange={(e) => setReply(e.target.value)}
            disabled={busy}
          />
          <div className="mail-row">
            <button className="btn ghost" onClick={() => void reportIt()}>
              举报
            </button>
            <button className="btn primary" onClick={() => void sendReply()} disabled={busy || !reply.trim()}>
              悄悄回一句
            </button>
          </div>
          <p className="mail-hint">回完之后就断了。它不会知道你有没有收到。</p>
        </section>
      )}

      {phase === 'replied' && (
        <section className="mail-card center">
          <p className="mail-big">已经放回去了。</p>
          <p className="mail-hint">对方可能已经漂走了，也可能哪天会看到。</p>
          <button className="btn" onClick={() => setPhase('write')}>
            回到瓶子
          </button>
        </section>
      )}
    </div>
  )
}
