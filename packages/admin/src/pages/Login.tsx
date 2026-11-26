import { useState } from 'react'
import { api, explain } from '../api'

/** 登录：API Key + TOTP。邀请制，无注册、无找回。 */
export function Login({ onDone, notice }: { onDone: () => Promise<void> | void; notice?: string }): React.ReactElement {
  const [username, setUsername] = useState('admin')
  const [apiKey, setApiKey] = useState('')
  const [totp, setTotp] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(notice || '')

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      await api.login(username.trim(), apiKey.trim(), totp.trim())
      await onDone()
    } catch (e2) {
      setErr(explain(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={(e) => void submit(e)}>
        <h1>灯塔</h1>
        <p className="sub hint">值班室 · 只有拿到钥匙的人能进来</p>
        {err && <div className="status err">{err}</div>}

        <label>账号</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />

        <label>API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="current-password"
          placeholder="创建账号时展示过一次"
        />

        <label>动态验证码</label>
        <input
          value={totp}
          onChange={(e) => setTotp(e.target.value)}
          inputMode="numeric"
          maxLength={6}
          placeholder="6 位数字"
          autoComplete="one-time-code"
        />

        <button className="btn primary" disabled={busy || !apiKey || !totp}>
          {busy ? '核对中…' : '进去值班'}
        </button>
      </form>
    </div>
  )
}
