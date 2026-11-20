import { useCallback, useEffect, useState } from 'react'
import type { BottleStatusView, LlmStatus, LocalModelsResult, MemoryListResult, OnlineAiConfigView } from '../../shared/types'

type StatusType = '' | 'ok' | 'err' | 'info'
interface StatusMsg {
  type: StatusType
  text: string
}

const LEGAL_DOCS = [
  { key: 'privacy', label: '隐私政策' },
  { key: 'terms', label: '用户协议' },
  { key: 'disclaimer', label: '免责声明' },
  { key: 'thirdparty', label: '第三方许可' },
] as const

export default function App(): React.ReactElement {
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const [online, setOnline] = useState<OnlineAiConfigView | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [token, setToken] = useState('')
  const [local, setLocal] = useState<LocalModelsResult | null>(null)
  const [localModel, setLocalModel] = useState('')
  const [pullName, setPullName] = useState('')
  const [pulling, setPulling] = useState(false)
  const [testing, setTesting] = useState(false)
  const [onlineStatus, setOnlineStatus] = useState<StatusMsg>({ type: '', text: '' })
  const [pullStatus, setPullStatus] = useState<StatusMsg>({ type: '', text: '' })
  const [animations, setAnimations] = useState(true)
  const [sound, setSound] = useState(true)
  const [petName, setPetName] = useState('')
  const [nameSaved, setNameSaved] = useState('')
  const [mem, setMem] = useState<MemoryListResult | null>(null)
  const [memStatus, setMemStatus] = useState('')
  const [bottle, setBottle] = useState<BottleStatusView | null>(null)
  const [bottleEndpoint, setBottleEndpoint] = useState('')
  const [animHint, setAnimHint] = useState('')
  const [previewing, setPreviewing] = useState(false)

  // ---------- 载入 ----------
  const refreshLlmStatus = useCallback(async () => {
    try {
      const status = await window.api.getLlmStatus()
      setLlm(status)
    } catch {
      setLlm(null)
    }
  }, [])

  const loadOnline = useCallback(async () => {
    try {
      const cfg = await window.api.getOnlineAiConfig()
      setOnline(cfg)
      setBaseUrl(cfg.baseUrl || '')
      setModel(cfg.model || '')
      setToken('')
    } catch (e) {
      window.logger.warn('settings.online', `load failed: ${(e as Error).message}`)
    }
  }, [])

  const refreshLocalModels = useCallback(async () => {
    try {
      const result = await window.api.getLocalModels()
      setLocal(result)
    } catch (e) {
      setLocal(null)
      window.logger.warn('settings.local', `load failed: ${(e as Error).message}`)
    }
  }, [])

  useEffect(() => {
    window.logger.info('settings.load', 'start')
    // 动画开关只读本地配置，先加载，避免被 Ollama 探测拖慢
    void (async () => {
      try {
        const v = await window.api.getConfig('animations')
        setAnimations(v !== false)
      } catch {
        setAnimations(true)
      }
      try {
        const snd = await window.api.getConfig('sound')
        setSound(snd !== false)
      } catch {
        setSound(true)
      }
      try {
        const pet = await window.api.getConfig('pet')
        setPetName(pet?.name || '')
      } catch {
        /* 忽略：名字为空即可 */
      }
      try {
        const b = await window.api.bottleStatus()
        setBottle(b)
        setBottleEndpoint(b.endpoint || '')
      } catch {
        setBottle(null)
      }
      try {
        setMem(await window.api.getMemories())
      } catch {
        /* 忽略：记忆不可用时隐藏列表 */
      }
      await refreshLlmStatus()
      await loadOnline()
      await refreshLocalModels()
    })()
    // 当前本地模型不通过 get-config 暴露，改用 llm-status 的 source 判断
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!animations) setAnimHint('已关闭：不播放过渡与预览动画')
    else if (reduced) setAnimHint('系统已开启「减少动态效果」，将自动跳过动画')
    else setAnimHint('点击球时播放短暂的动作反馈')
  }, [animations])

  // ---------- 线上模型 ----------
  const saveOnline = async (): Promise<void> => {
    try {
      const result = await window.api.saveOnlineAiConfig({ baseUrl: baseUrl.trim(), model: model.trim(), token: token.trim() })
      setToken('')
      await loadOnline()
      await refreshLlmStatus()
      setOnlineStatus({ type: 'ok', text: result.tokenHint ? `✅ 已保存（${result.tokenHint}）` : '✅ 已保存' })
    } catch (e) {
      setOnlineStatus({ type: 'err', text: '保存失败：' + ((e as Error).message || e) })
    }
  }

  const testOnline = async (): Promise<void> => {
    setTesting(true)
    setOnlineStatus({ type: 'info', text: '正在测试连接…' })
    try {
      const result = await window.api.testOnlineAi()
      setOnlineStatus(
        result.ok
          ? { type: 'ok', text: `✅ 连接成功${result.model ? ' · ' + result.model : ''}` }
          : { type: 'err', text: '连接失败：' + (result.error || '未知错误') },
      )
    } catch (e) {
      setOnlineStatus({ type: 'err', text: '测试失败：' + ((e as Error).message || e) })
    } finally {
      setTesting(false)
    }
  }

  const clearToken = async (): Promise<void> => {
    try {
      const result = await window.api.clearOnlineAiToken()
      await loadOnline()
      await refreshLlmStatus()
      setOnlineStatus({
        type: result.ok ? 'ok' : 'err',
        text: result.hasToken ? '✅ 已清除本机保存的 Key，当前使用 .env' : '✅ 已清除，当前没有可用 Key',
      })
    } catch (e) {
      setOnlineStatus({ type: 'err', text: '清除失败：' + ((e as Error).message || e) })
    }
  }

  // ---------- 本地模型 ----------
  const selectLocal = async (name: string): Promise<void> => {
    setLocalModel(name)
    await window.api.setLocalModel(name)
    await refreshLlmStatus()
    setPullStatus({ type: 'info', text: name ? `已切换到本地模型 ${name}` : '已切换回线上模型' })
  }

  const useOnline = async (): Promise<void> => {
    setLocalModel('')
    await window.api.setLocalModel('')
    await refreshLlmStatus()
    setPullStatus({ type: 'info', text: '已切换回线上模型' })
  }

  const pull = async (): Promise<void> => {
    const name = pullName.trim()
    if (!name) {
      setPullStatus({ type: 'err', text: '请输入模型名' })
      return
    }
    setPulling(true)
    setPullStatus({ type: 'info', text: `正在下载 ${name}（大模型可能需要几分钟，请耐心等待）...` })
    try {
      const result = await window.api.pullLocalModel(name)
      if (result.ok) {
        setPullStatus({ type: 'ok', text: `✅ ${name} 下载完成` })
        setPullName('')
        await refreshLocalModels()
      } else {
        setPullStatus({ type: 'err', text: `下载失败：${result.error || '未知错误'}` })
      }
    } catch (e) {
      setPullStatus({ type: 'err', text: '下载失败：' + ((e as Error).message || e) })
    } finally {
      setPulling(false)
    }
  }

  // ---------- 动画 ----------
  const toggleAnimations = async (enabled: boolean): Promise<void> => {
    setAnimations(enabled)
    try {
      await window.api.saveConfig('animations', enabled)
    } catch {
      setAnimations(!enabled)
    }
  }

  const toggleSound = async (enabled: boolean): Promise<void> => {
    setSound(enabled)
    try {
      await window.api.saveConfig('sound', enabled)
    } catch {
      setSound(!enabled)
    }
  }

  const previewAnim = async (): Promise<void> => {
    setPreviewing(true)
    try {
      await window.api.previewBallAnim()
    } catch (e) {
      window.logger.warn('settings.anim', `preview failed: ${(e as Error).message}`)
    } finally {
      setTimeout(() => setPreviewing(false), 2600)
    }
  }

  // ---------- 起名 ----------
  const savePetName = async (): Promise<void> => {
    const name = petName.trim()
    try {
      await window.api.setPetName(name)
      setNameSaved(name ? `已保存：${name}` : '已清空名字')
      window.logger.info('settings.petName', `saved (${name ? name.length + ' chars' : 'empty'})`)
    } catch (e) {
      setNameSaved('保存失败：' + ((e as Error).message || e))
    }
  }

  // ---------- 记忆 ----------
  const refreshMemories = async (): Promise<void> => {
    setMem(await window.api.getMemories())
  }
  const deleteMemory = async (id: string): Promise<void> => {
    setMem(await window.api.deleteMemory(id))
  }
  const clearMemories = async (): Promise<void> => {
    setMem(await window.api.clearMemories())
  }
  const toggleMemory = async (enabled: boolean): Promise<void> => {
    await window.api.setMemoryEnabled(enabled)
    await refreshMemories()
  }

  // ---------- 许愿瓶 ----------
  const toggleBottle = async (enabled: boolean): Promise<void> => {
    const view = await window.api.bottleToggle({ enabled, endpoint: bottleEndpoint.trim() })
    setBottle(view)
    window.logger.info('settings.bottle', `enabled=${enabled}`)
  }

  // ---------- 备份 ----------
  const exportBackup = async (): Promise<void> => {
    const r = await window.api.exportBackup()
    if (r.ok) setMemStatus('已导出全部数据')
    else if (!r.canceled) setMemStatus(r.error || '导出失败')
  }
  const importBackup = async (): Promise<void> => {
    const r = await window.api.importBackup()
    if (r.ok) {
      setMemStatus(`已导入：${r.stats?.memories ?? 0} 条记忆、${r.stats?.diaryEntries ?? 0} 篇日记`)
      await refreshMemories()
      const pet = await window.api.getConfig('pet')
      setPetName(pet?.name || '')
    } else if (!r.canceled) {
      setMemStatus(r.error || '导入失败')
    }
  }

  // ---------- 渲染 ----------
  const llmText = !llm
    ? '模型状态检测失败'
    : llm.source === 'local'
      ? `🟢 当前：本地模型 ${llm.model}`
      : llm.source === 'online'
        ? `🌐 当前：线上模型 ${llm.model}`
        : '⚠️ 未配置 AI'
  const llmClass = !llm ? '' : llm.source === 'local' ? 'local' : llm.source === 'online' ? 'online' : 'none'

  const tokenHint = online
    ? online.fromBundled
      ? `当前使用应用内置 Key（${online.tokenHint}），留空则不修改`
      : online.fromEnv
        ? `当前使用 .env 中的 Key（${online.tokenHint}）`
        : online.hasToken
          ? `已保存 Key（${online.tokenHint}），留空则不修改`
          : '尚未配置 API Key，填入后点保存'
    : ''

  const localHint = !local
    ? '获取本地模型失败'
    : !local.available
      ? '未检测到 Ollama（本地推理服务）。请先安装并启动 Ollama，再点「刷新列表」。'
      : local.models.length === 0
        ? 'Ollama 已运行，但还没有模型。用下方「下载模型」拉取一个。'
        : `检测到 ${local.models.length} 个本地模型。选中即启用本地。`

  return (
    <div className="settings">
      <h1>设置</h1>

      <div className={`llm-status ${llmClass}`}>{llmText}</div>

      <section className="section">
        <h2>线上模型</h2>
        <p className="hint">
          填写后优先生效（优先级：设置面板 &gt; 本机 <code>.env</code> &gt; 应用内置 Key）。Key 只存在这台电脑，
          不会进 git，已保存的不必重填。
        </p>

        <label>
          <span>Base URL</span>
          <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" autoComplete="off" />
        </label>
        <label>
          <span>模型名</span>
          <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" autoComplete="off" />
        </label>
        <label>
          <span>API Key</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="留空表示不修改已保存的 Key" autoComplete="off" />
          <small>{tokenHint}</small>
        </label>
        <div className="row">
          <button className="btn primary" onClick={() => void saveOnline()}>保存线上配置</button>
          <button className="btn" onClick={() => void testOnline()} disabled={testing}>测试连接</button>
          <button className="btn ghost" onClick={() => void clearToken()}>清除已存 Key</button>
        </div>
        {onlineStatus.text && <div className={`status ${onlineStatus.type}`}>{onlineStatus.text}</div>}
      </section>

      <section className="section">
        <h2>本地模型</h2>
        <p className="hint">本机已装 Ollama 时可改用本地模型；选空则继续用上面的线上配置。</p>
        <label>
          <span>当前本地模型</span>
          <select value={localModel} onChange={(e) => void selectLocal(e.target.value)}>
            <option value="">（使用线上 DeepSeek）</option>
            {(local?.models || []).map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
                {m.sizeLabel ? `（${m.sizeLabel}）` : ''}
              </option>
            ))}
          </select>
          <small>{localHint}</small>
        </label>
        <div className="row">
          <button className="btn" onClick={() => void refreshLocalModels()}>刷新列表</button>
          <button className="btn ghost" onClick={() => void useOnline()}>使用线上</button>
        </div>
      </section>

      <section className="section">
        <h2>下载本地模型</h2>
        <p className="hint">
          输入模型名（如 <code>qwen2.5:7b</code>、<code>llama3</code>），从 Ollama 下载到本机。
        </p>
        <div className="row">
          <input
            type="text"
            value={pullName}
            onChange={(e) => setPullName(e.target.value)}
            placeholder="qwen2.5:7b"
            autoComplete="off"
          />
          <button className="btn primary" onClick={() => void pull()} disabled={pulling}>下载</button>
        </div>
        {pullStatus.text && <div className={`status ${pullStatus.type}`}>{pullStatus.text}</div>}
      </section>

      <section className="section">
        <h2>给它起个名字</h2>
        <p className="hint">起名是它记住你的开始。名字会用在以后的日记与招呼里，随时可以改。</p>
        <div className="row">
          <input
            type="text"
            value={petName}
            maxLength={16}
            placeholder="比如：团子"
            onChange={(e) => setPetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void savePetName()
            }}
          />
          <button className="btn primary" onClick={() => void savePetName()}>
            保存名字
          </button>
        </div>
        <small id="pet-name-hint">{nameSaved || '不超过 16 个字，留空表示不改'}</small>
      </section>

      <section className="section">
        <h2>它记得什么</h2>
        <p className="hint">
          只在这台电脑上。关掉就不再抽取新的；已有记忆可以逐条删除。
          {mem ? `（${mem.memories.length}/${mem.max}）` : ''}
        </p>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={mem?.enabled !== false}
            onChange={(e) => void toggleMemory(e.target.checked)}
          />
          <span className="switch-track"><i /></span>
          <span className="switch-label">让它记住我们说过的事</span>
        </label>

        {mem && mem.memories.length > 0 ? (
          <ul className="mem-list">
            {mem.memories.map((m) => (
              <li key={m.id} className="mem-item">
                <span>{m.text}</span>
                <button className="mem-del" onClick={() => void deleteMemory(m.id)} title="删除这条记忆">
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">还没有记忆。多聊几次，它会开始记住一些事。</p>
        )}
        {mem && mem.memories.length > 0 && (
          <div className="row">
            <button className="btn ghost" onClick={() => void clearMemories()}>
              全部忘记
            </button>
          </div>
        )}
      </section>

      <section className="section">
        <h2>许愿瓶</h2>
        <p className="hint">
          把一句话放进瓶子，它会漂给另一个也醒着的人。纸条会**发送到服务器**，对方只能看到随机代号；
          不能私聊，七天后没人捡就沉海。
        </p>
        <label>
          <span>服务端地址</span>
          <input
            type="text"
            value={bottleEndpoint}
            placeholder="https://your-worker.workers.dev"
            onChange={(e) => setBottleEndpoint(e.target.value)}
            onBlur={() => {
              if (bottle?.enabled) void toggleBottle(true)
            }}
          />
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={bottle?.enabled === true}
            onChange={(e) => void toggleBottle(e.target.checked)}
          />
          <span className="switch-track"><i /></span>
          <span className="switch-label">开启许愿瓶</span>
        </label>
        {bottle?.enabled && (
          <div className="row">
            <button className="btn" onClick={() => void window.api.openMail()}>
              打开许愿瓶
            </button>
            <small className="inline-hint">
              今天已放 {bottle.thrownToday}/{bottle.dailyLimit} 张
            </small>
          </div>
        )}
      </section>

      <section className="section">
        <h2>数据备份</h2>
        <p className="hint">
          导出名字、记忆、笔记本与聊天记录（不含 API Key）。换电脑或重装时用它恢复。
        </p>
        <div className="row">
          <button className="btn" onClick={() => void exportBackup()}>
            导出全部数据
          </button>
          <button className="btn" onClick={() => void importBackup()}>
            导入备份
          </button>
        </div>
        {memStatus && <small>{memStatus}</small>}
      </section>

      <section className="section">
        <h2>桌面形象</h2>
        <p className="hint">S0 仅团子猫一种形象；S7 会以「角色包 / 皮肤」扩展，届时在此切换。</p>
        <label>
          <span>形象</span>
          <select value="cat" disabled>
            <option value="cat">团子猫</option>
          </select>
          <small>当前版本只有一种形象</small>
        </label>
      </section>

      <section className="section">
        <h2>动画</h2>
        <p className="hint">角色互动时播放轻量动画。系统开启「减少动态效果」时会自动跳过。</p>
        <label className="switch-row">
          <input type="checkbox" checked={animations} onChange={(e) => void toggleAnimations(e.target.checked)} />
          <span className="switch-track"><i /></span>
          <span className="switch-label">播放角色动画</span>
        </label>
        <p className="hint">S0 骨架：动画细节随 S1「它有自己的生活」扩展。</p>
        <div className="row">
          <button className="btn" onClick={() => void previewAnim()} disabled={previewing}>▶ 预览动画</button>
          <small className={`inline-hint${animHint.includes('系统') ? ' warn' : ''}`}>{animHint}</small>
        </div>
      </section>

      <section className="section">
        <h2>声音</h2>
        <p className="hint">落地、被摸头、爬上屏幕顶部时的轻响。默认开，音量很低。</p>
        <label className="switch-row">
          <input type="checkbox" checked={sound} onChange={(e) => void toggleSound(e.target.checked)} />
          <span className="switch-track"><i /></span>
          <span className="switch-label">播放轻音效</span>
        </label>
      </section>

      <section className="section">
        <h2>关于</h2>
        <p className="hint">桌面陪伴 · 团子猫 · 本应用核心功能离线可用，AI 为可选增强。</p>
        <div className="row legal-row">
          {LEGAL_DOCS.map((d) => (
            <button key={d.key} className="btn legal-btn" onClick={() => void window.api.openLegal(d.key)}>
              {d.label}
            </button>
          ))}
        </div>
        <p className="hint legal-note">AI 回复由用户自行配置的模型生成，仅供参考，不构成医疗、法律或投资建议。</p>
      </section>
    </div>
  )
}
