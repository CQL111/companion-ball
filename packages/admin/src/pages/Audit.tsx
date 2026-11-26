import { useEffect, useState } from 'react'
import { api, explain, type AuditItem } from '../api'

/** 审计：只追加。谁在什么时候做了什么。 */
export function Audit(): React.ReactElement {
  const [items, setItems] = useState<AuditItem[]>([])
  const [err, setErr] = useState('')

  useEffect(() => {
    api
      .audit()
      .then((r) => setItems(r.items))
      .catch((e) => setErr(explain(e)))
  }, [])

  if (err) return <div className="status err">{err}</div>

  return (
    <>
      <h1>审计</h1>
      <p className="sub">登录、审核、开关、账号变更都在这里。只追加，保留一年。</p>

      {items.length === 0 ? (
        <div className="empty">还没有记录。</div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>谁</th>
                <th>做了什么</th>
                <th>对象</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="mono">{a.actor.slice(0, 10)}</td>
                  <td>{a.action}</td>
                  <td className="mono">{a.target?.slice(0, 12) ?? '—'}</td>
                  <td className="hint">{a.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
