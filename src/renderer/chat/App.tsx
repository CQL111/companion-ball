import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMessage } from '../../shared/types'

type StatusKind = '' | 'info' | 'error'

function friendlyError(raw: string): string {
  const code = String(raw || '')
  const MAP: Record<string, string> = {
    NO_TOKEN: '尚未配置 API Key，请先在设置里填写',
    AUTH_FAILED: 'API Key 无效或已过期，请到设置里更新',
    INSUFFICIENT_BALANCE: 'AI 额度已用尽，请充值或在设置里换用自己的 Key',
    RATE_LIMITED: '调用太频繁，请稍后再试',
    TIMEOUT: '网络有点慢，稍后再试',
    NETWORK: '网络似乎不太稳定',
    UPSTREAM_ERROR: '模型服务返回错误，稍后再试',
    BAD_JSON: '模型返回格式异常，稍后重试',
    EMPTY_QUERY: '先说点什么吧',
    EMPTY_RESPONSE: '团子没接上话，再说一次试试',
    AGENT_MAX_STEPS: '这轮调用太长，请换个说法再问',
  }
  const main = code.split(':')[0]?.trim() || ''
  if (MAP[main]) return MAP[main]
  if (/余额不足|insufficient/i.test(code)) return 'AI 额度已用尽，请充值或在设置里换用自己的 Key'
  if (/invalid_api_key|Incorrect API key/i.test(code)) return 'API Key 无效，请到设置里更新'
  if (/model_not_found|does not exist/i.test(code)) return '模型名不可用，请在设置里修改模型名'
  return '请求失败：' + (code || '未知错误')
}

export default function App(): React.ReactElement {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({ kind: '', text: '' })
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const scrollToEnd = useCallback(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    scrollToEnd()
  }, [messages, scrollToEnd])

  // 主进程事件：聚焦时同步历史、加载状态、错误提示
  useEffect(() => {
    const offFocus = window.api.onAiInputFocus((data) => {
      window.logger.info('aiInput.event', 'focused')
      setMessages((data?.messages || []).filter((m) => m.content))
      setDraft('')
      setStatus({ kind: '', text: '' })
      requestAnimationFrame(() => inputRef.current?.focus())
    })
    const offLoading = window.api.onAiInputLoading((loading) => {
      setBusy(!!loading)
      if (loading) setStatus({ kind: 'info', text: '✨ 思考中…' })
    })
    const offError = window.api.onAiInputError((err) => {
      setStatus({ kind: 'error', text: err.text || '出错了' })
      setBusy(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    })
    const offProgress = window.api.onAgentProgress((info) => {
      const label = info?.label || info?.tool || '思考'
      setStatus({ kind: 'info', text: '✨ ' + label + '…' })
    })
    return () => {
      offFocus()
      offLoading()
      offError()
      offProgress()
    }
  }, [])

  const submit = useCallback(async () => {
    const q = draft.trim()
    if (!q || busy) {
      if (!q) setStatus({ kind: 'error', text: '先说点什么吧' })
      return
    }
    setDraft('')
    setMessages((prev) => [...prev, { role: 'user', content: q }])
    setBusy(true)
    setStatus({ kind: 'info', text: '✨ 思考中…' })
    window.logger.info('aiInput.submit', `query length=${q.length}`)
    try {
      const result = await window.api.aiInterpretAsk({ query: q })
      if (!result.ok) {
        setStatus({ kind: 'error', text: friendlyError(result.error || '') })
      } else if (result.text) {
        setMessages((prev) => [...prev, { role: 'assistant', content: result.text! }])
        setStatus(result.notice ? { kind: 'info', text: '⚠️ ' + result.notice } : { kind: '', text: '' })
      }
    } catch (e) {
      setStatus({ kind: 'error', text: '请求失败：' + ((e as Error).message || e) })
    } finally {
      setBusy(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [draft, busy])

  const reset = useCallback(async () => {
    if (busy) return
    await window.api.resetAgentChat()
    setMessages([])
    setStatus({ kind: '', text: '' })
    inputRef.current?.focus()
  }, [busy])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape') {
      void window.api.closeAiInput()
    }
  }

  return (
    <div className="ai-input">
      <div className="ai-input-header">
        <span className="ai-icon">✨</span>
        <span className="ai-title">和团子聊天</span>
        <button className="ai-reset" onClick={() => void reset()} disabled={busy} title="新对话">
          新对话
        </button>
        <button className="ai-close" onClick={() => void window.api.closeAiInput()} title="关闭">
          ×
        </button>
      </div>
      <div className="ai-input-body">
        <div className="ai-messages" ref={listRef}>
          {messages.length === 0 ? (
            <div className="ai-empty">想聊什么都可以。它会记得你们最近说过的话。</div>
          ) : (
            messages.map((m, i) => (
              <div key={`${m.role}-${i}`} className={`msg ${m.role}`}>
                {m.content}
              </div>
            ))
          )}
        </div>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="想聊点什么？比如：今天好累，陪我坐一会儿"
          rows={2}
          maxLength={400}
          disabled={busy}
        />
        <div className="ai-actions">
          <span className="ai-hint">Enter 发送 · Shift+Enter 换行</span>
          <button className="ai-submit" onClick={() => void submit()} disabled={busy}>
            发送
          </button>
        </div>
        <div className={`ai-status ${status.kind}`}>{status.text}</div>
      </div>
    </div>
  )
}
