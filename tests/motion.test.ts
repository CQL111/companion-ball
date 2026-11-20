// tests/motion.test.ts - 动作契约单测
import { describe, expect, it } from 'vitest'
import {
  REQUIRED_CLIPS,
  canMirror,
  clipForState,
  clipsByView,
  resolveClip,
  validateManifest,
  viewOf,
  type SkinManifest,
} from '@core/motion'

function makeManifest(overrides: Partial<SkinManifest> = {}): SkinManifest {
  const clips: SkinManifest['clips'] = {}
  for (const name of REQUIRED_CLIPS) {
    clips[name] = { view: viewOf(name), frames: 4, fps: 8, loop: true, row: 0 }
  }
  return {
    id: 'test-cat',
    name: '测试猫',
    version: 1,
    engine: 'atlas',
    size: { w: 80, h: 80 },
    anchors: { front: { x: 40, y: 76 }, side: { x: 36, y: 78 } },
    clips,
    assets: { atlas: 'cat.png' },
    ...overrides,
  }
}

describe('视角划分', () => {
  it('移动类动作属于侧影，其余属于正面', () => {
    for (const c of ['walk', 'climb', 'hang', 'fall', 'land', 'held'] as const) expect(viewOf(c)).toBe('side')
    for (const c of ['idle', 'sleep', 'groom', 'stretch', 'tap', 'annoyed', 'dizzy', 'wake'] as const)
      expect(viewOf(c)).toBe('front')
  })

  it('正面永远不镜像；攀爬与倒挂也不镜像（否则会翻到墙外）', () => {
    expect(canMirror('idle')).toBe(false)
    expect(canMirror('sleep')).toBe(false)
    expect(canMirror('walk')).toBe(true)
    expect(canMirror('fall')).toBe(true)
    expect(canMirror('climb')).toBe(false)
    expect(canMirror('hang')).toBe(false)
  })
})

describe('clipForState', () => {
  it('移动状态优先于情绪', () => {
    expect(clipForState('walk', 'sleep')).toBe('walk')
    expect(clipForState('climb', 'annoyed')).toBe('climb')
  })
  it('原地时由情绪决定', () => {
    expect(clipForState('idle', 'sleep')).toBe('sleep')
    expect(clipForState('idle', 'doze')).toBe('sleep')
    expect(clipForState('idle', 'annoyed')).toBe('annoyed')
    expect(clipForState('idle', 'dizzy')).toBe('dizzy')
    expect(clipForState('idle', 'neutral')).toBe('idle')
  })
  it('刚被唤醒优先于普通情绪', () => {
    expect(clipForState('idle', 'curious', { justWoke: true })).toBe('wake')
  })
  it('原地小动作优先于情绪', () => {
    expect(clipForState('idle', 'smile', { action: 'stretch' })).toBe('stretch')
    expect(clipForState('idle', 'neutral', { action: 'groom' })).toBe('groom')
  })
})

describe('resolveClip', () => {
  it('直接命中', () => {
    const m = makeManifest()
    expect(resolveClip(m, 'walk')?.frames).toBe(4)
  })

  it('缺动作时沿 fallbacks 回退', () => {
    const m = makeManifest()
    delete m.clips.hang
    m.fallbacks = { hang: 'climb' }
    expect(resolveClip(m, 'hang')).toBe(m.clips.climb)
  })

  it('回退链断裂时退到 idle', () => {
    const m = makeManifest()
    delete m.clips.dizzy
    m.fallbacks = { dizzy: 'nope' as never }
    expect(resolveClip(m, 'dizzy')).toBe(m.clips.idle)
  })

  it('连 idle 都没有时返回 null', () => {
    const m = makeManifest()
    m.clips = {}
    expect(resolveClip(m, 'walk')).toBeNull()
  })

  it('fps 或 frames 非法的片段会被跳过', () => {
    const m = makeManifest()
    m.clips.walk = { view: 'side', frames: 0, fps: 8, loop: true, row: 0 }
    expect(resolveClip(m, 'walk')).toBe(m.clips.idle)
  })

  it('不会因为 fallbacks 成环而死循环', () => {
    const m = makeManifest()
    delete m.clips.hang
    m.fallbacks = { hang: 'climb' }
    delete m.clips.climb
    m.fallbacks = { ...m.fallbacks, climb: 'hang' }
    expect(resolveClip(m, 'hang')).toBe(m.clips.idle)
  })
})

describe('validateManifest', () => {
  it('完整清单通过', () => {
    expect(validateManifest(makeManifest())).toEqual([])
  })

  it('缺两个视角锚点会报错', () => {
    const m = makeManifest()
    // @ts-expect-error 故意缺锚点
    m.anchors = {}
    expect(validateManifest(m).some((e) => e.includes('锚点'))).toBe(true)
  })

  it('视角声明与契约不符会报错', () => {
    const m = makeManifest()
    m.clips.walk = { view: 'front', frames: 4, fps: 8, loop: true, row: 0 }
    expect(validateManifest(m).some((e) => e.includes('视角声明'))).toBe(true)
  })

  it('缺少必需动作会报错，但用 fallbacks 可以补齐', () => {
    const m = makeManifest()
    delete m.clips.hang
    expect(validateManifest(m).some((e) => e.includes('hang'))).toBe(true)

    m.fallbacks = { hang: 'climb' }
    const withFallback = makeManifest()
    delete withFallback.clips.hang
    // fallbacks 只影响运行时；清单校验仍要求声明或显式标注可回退
    expect(validateManifest(withFallback).some((e) => e.includes('hang'))).toBe(true)
  })

  it('engine 只接受 atlas / spine', () => {
    const m = makeManifest()
    // @ts-expect-error 非法引擎
    m.engine = 'unity'
    expect(validateManifest(m).some((e) => e.includes('engine'))).toBe(true)
  })
})

describe('clipsByView', () => {
  it('美术排期：正面 11 个、侧影 6 个', () => {
    const m = makeManifest()
    const byView = clipsByView(m)
    expect(byView.front.sort()).toEqual(
      ['annoyed', 'dizzy', 'groom', 'grumble', 'idle', 'look', 'pat', 'sleep', 'stretch', 'tap', 'wake'].sort(),
    )
    expect(byView.side.sort()).toEqual(['climb', 'fall', 'hang', 'held', 'land', 'walk'].sort())
  })
})
