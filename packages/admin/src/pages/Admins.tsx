import { useCallback, useEffect, useState } from 'react'
import { api, explain, type AdminItem, type Role } from '../api'

/**
 * 守塔人：账号管理。邀请制、无注册、无找回。
 * 创建时只展示一次 API Key 与 TOTP 密钥——之后永不显示。
 */
export function Admins(): React.ReactElement {
  const [items, setItems] = useState<AdminItem[]>([])
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<Role>('operator')
  const [created, setCreated] = useState<{ apiKey: string; totpSecret: string; username: string } | null>(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      setItems((await api.admins()).items)
    } catch (e) {
      setMsg(explain(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (): Promise<void> => {
    if (!username.trim()) return
    try {
      const r = await api.createAdmin(username.trim(), role)
      setCreated({ apiKey: r.apiKey, totpSecret: r.totpSecret, username: username.trim() })
      setUsername('')
      setMsg('已创建。下面这串只显示这一次。')
      await load()
    } catch (e) {
      setMsg(explain(e))
    }
  }

  const toggleDisabled = async (a: AdminItem): Promise<void> => {
    try {
      await api.updateAdmin(a.id, { disabled: !a.disabled })
      await load()
    } catch (e) {
      setMsg(explain(e))
    }
  }

  const reset = async (a: AdminItem): Promise<void> => {
    try {
      const r = await api.resetKey(a.id)
      setCreated({ apiKey: r.apiKey, totpSecret: '（TOTP 不变）', username: a.username })
      setMsg('新 Key 只显示这一次')
    } catch (e) {
      setMsg(explain(e))
    }
  }

  return (
    <>
      <h1>守塔人</h1>
      <p className="sub">第一年只开一到三个账号。少就是安全。</p>

      {msg && <div className="status ok">{msg}</div>}

      {created && (
        <div className="card" style={{ borderColor: 'rgba(213,169,97,0.4)' }}>
          <h3>只显示这一次</h3>
          <p className="hint">请立刻复制到安全的地方。关掉这个页面就再也看不到了。</p>
          <div className="field" style={{ marginTop: 10 }}>
            <label>{created.username} · API Key</label>
            <input readOnly value={created.apiKey} className="mono" onFocus={(e) => e.target.select()} />
          </div>
          <div className="field">
            <label>TOTP 密钥（加到验证器 App）</label>
            <input readOnly value={created.totpSecret} className="mono" onFocus={(e) => e.target.select()} />
          </div>
          <button className="btn" onClick={() => setCreated(null)}>
            我存好了
          </button>
        </div>
      )}

      <div className="card">
        <h3>新建账号</h3>
        <div className="row">
          <input className="grow" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="账号名" />
          <select style={{ width: 130 }} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="viewer">viewer 只看</option>
            <option value="operator">operator 审核</option>
            <option value="admin">admin 全部</option>
          </select>
          <button className="btn primary" onClick={() => void create()}>
            创建
          </button>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>账号</th>
              <th>角色</th>
              <th>状态</th>
              <th>上次登录</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>{a.username}</td>
                <td className="mono">{a.role}</td>
                <td>{a.disabled ? <span className="tag danger">已停用</span> : <span className="tag ok">正常</span>}</td>
                <td className="mono">{a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : '—'}</td>
                <td>
                  <div className="row">
                    <button className="btn sm" onClick={() => void reset(a)}>
                      重置 Key
                    </button>
                    <button className="btn sm" onClick={() => void toggleDisabled(a)}>
                      {a.disabled ? '启用' : '停用'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
