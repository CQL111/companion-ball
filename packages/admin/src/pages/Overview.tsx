import { useEffect, useState } from 'react'
import { api, explain, type Overview as OverviewData } from '../api'

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

/** 概览：先待办，后数字。刻意不显示 DAU / 停留时长 / PV。 */
export function Overview({ onJump }: { onJump: (p: string) => void }): React.ReactElement {
  const [d, setD] = useState<OverviewData | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    api
      .overview()
      .then(setD)
      .catch((e) => setErr(explain(e)))
  }, [])

  if (err) return <div className="status err">{err}</div>
  if (!d) return <div className="empty">正在看海面…</div>

  const emergency = d.flags.EMERGENCY_OFF

  return (
    <>
      <h1>今天的海面</h1>
      <p className="sub">先看要做什么，再看数字。</p>

      {emergency && <div className="banner-emergency">封海中：所有写接口已关闭</div>}
      {d.alerts.map((a) => (
        <div key={a} className="alert">
          {a}
        </div>
      ))}

      <div className="grid">
        <div className="card">
          <h3>待办</h3>
          <div className="todo">
            <span className="n">{d.todo.galleryPending}</span>
            <span className="l">橱窗待审</span>
          </div>
          <div className="todo" style={{ marginTop: 6 }}>
            <span className="n" style={{ color: d.todo.reportsOpen ? 'var(--danger)' : undefined }}>
              {d.todo.reportsOpen}
            </span>
            <span className="l">
              举报待处理
              {d.todo.oldestReportHours > 0 ? `（最久 ${d.todo.oldestReportHours} 小时前）` : ''}
            </span>
          </div>
          <div className="todo" style={{ marginTop: 6 }}>
            <span className="n">{d.todo.newsPublishedToday}</span>
            <span className="l">今日已发新闻</span>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => onJump('moderation')}>
              去值班 →
            </button>
          </div>
        </div>

        <div className="card">
          <h3>近 7 天</h3>
          <div className="ratio">
            <div className="n">{pct(d.ratios.pickRate)}</div>
            <div className="l">瓶子被捡率</div>
          </div>
          <div className="ratio" style={{ marginTop: 8 }}>
            <div className="n">{pct(d.ratios.replyRate)}</div>
            <div className="l">回信率</div>
          </div>
          <div className="ratio" style={{ marginTop: 8 }}>
            <div className="n" style={{ color: d.ratios.reportRate > 0.005 ? 'var(--danger)' : undefined }}>
              {pct(d.ratios.reportRate)}
            </div>
            <div className="l">举报率（红线 0.5%）</div>
          </div>
          <div className="ratio" style={{ marginTop: 8 }}>
            <div className="n">{pct(d.ratios.seedShare)}</div>
            <div className="l">种子占比（上限 50%）</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>开关</h3>
        <div className="row">
          {Object.entries(d.flags).map(([k, v]) => (
            <span key={k} className={`tag ${v ? 'danger' : 'ok'}`}>
              {k} {v ? '关' : '开'}
            </span>
          ))}
        </div>
      </div>
    </>
  )
}
