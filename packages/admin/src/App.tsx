import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, explain, Unauthorized, type Me } from './api'
import { Login } from './pages/Login'
import { Overview } from './pages/Overview'
import { Moderation } from './pages/Moderation'
import { Gallery } from './pages/Gallery'
import { News } from './pages/News'
import { Leads } from './pages/Leads'
import { Flags } from './pages/Flags'
import { Audit } from './pages/Audit'
import { Admins } from './pages/Admins'

type Page = 'overview' | 'moderation' | 'gallery' | 'news' | 'leads' | 'flags' | 'audit' | 'admins'

// 后台只有 8 个页面，用 hash 切页即可——不引入路由库
function readHash(): Page {
  const raw = location.hash.replace(/^#\/?/, '')
  const allow: Page[] = ['overview', 'moderation', 'gallery', 'news', 'leads', 'flags', 'audit', 'admins']
  return (allow as string[]).includes(raw) ? (raw as Page) : 'overview'
}

const NAV: Array<{ key: Page; label: string; role?: 'admin' }> = [
  { key: 'overview', label: '概览' },
  { key: 'moderation', label: '值班' },
  { key: 'gallery', label: '橱窗' },
  { key: 'news', label: '海的记录' },
  { key: 'leads', label: '线索' },
  { key: 'flags', label: '封海' },
  { key: 'audit', label: '审计' },
  { key: 'admins', label: '守塔人', role: 'admin' },
]

export default function App(): React.ReactElement {
  const [me, setMe] = useState<Me | null>(null)
  const [checking, setChecking] = useState(true)
  const [page, setPage] = useState<Page>(readHash())
  const [error, setError] = useState('')

  const loadMe = useCallback(async () => {
    try {
      setMe(await api.me())
    } catch (e) {
      if (!(e instanceof Unauthorized)) setError(explain(e))
      setMe(null)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void loadMe()
    const onHash = (): void => setPage(readHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [loadMe])

  const logout = async (): Promise<void> => {
    try {
      await api.logout()
    } finally {
      setMe(null)
      location.hash = ''
    }
  }

  const nav = useMemo(() => NAV.filter((n) => !n.role || me?.role === n.role), [me])

  if (checking) return <div className="empty">正在核对身份…</div>
  if (!me) return <Login onDone={loadMe} notice={error} />

  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">灯 塔</div>
        {nav.map((n) => (
          <a key={n.key} href={`#/${n.key}`} className={page === n.key ? 'on' : ''}>
            {n.label}
          </a>
        ))}
        <div className="foot">
          {me.username} · {me.role}
          <br />
          <button onClick={() => void logout()}>退出</button>
        </div>
      </nav>
      <main className="main">
        {page === 'overview' && <Overview onJump={(p) => (location.hash = `#/${p}`)} />}
        {page === 'moderation' && <Moderation />}
        {page === 'gallery' && <Gallery />}
        {page === 'news' && <News />}
        {page === 'leads' && <Leads />}
        {page === 'flags' && <Flags role={me.role} />}
        {page === 'audit' && <Audit />}
        {page === 'admins' && me.role === 'admin' && <Admins />}
      </main>
    </div>
  )
}
