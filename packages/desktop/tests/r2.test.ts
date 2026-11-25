// package 前置：r2.js 是 CommonJS（scripts/ 下无 type:module），用 createRequire 引入
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadR2(): any {
  return require(path.join(__dirname, '..', '..', '..', 'scripts', 'r2.js'))
}

describe('R2 SigV4 签名', () => {
  it('与 AWS 官方测试向量 get-vanilla 一致', () => {
    const r2 = loadR2()
    const cfg = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }
    // AWS 文档：20150830T123600Z
    const now = new Date(Date.UTC(2015, 7, 30, 12, 36, 0))
    const headers = { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' }
    const out = r2.awsSign(cfg, 'GET', '/', '', headers, now, { region: 'us-east-1', service: 'service' })
    expect(out._debug.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
  })

  it('canonical request 最后一行是 payload hash', () => {
    const r2 = loadR2()
    const cfg = { accessKeyId: 'A', secretAccessKey: 'B' }
    const now = new Date(Date.UTC(2015, 7, 30, 12, 36, 0))
    const out = r2.awsSign(
      cfg,
      'GET',
      '/',
      '',
      { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      now,
      { region: 'us-east-1', service: 'service' },
    )
    const lines = out._debug.canonicalRequest.split('\n')
    // 结构：方法 / 路径 / 空查询 / canonical 头（末尾换行→空行）/ signedHeaders / payload hash
    expect(lines[lines.length - 1]).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('R2 请求使用 path-style 且桶名在路径中', () => {
    const r2 = loadR2()
    const cfg = { accountId: 'acc', accessKeyId: 'A', secretAccessKey: 'B', bucket: 'my-bucket' }
    const { url, headers } = r2.signRequest(cfg, 'PUT', 'releases/v0.9.1/a b.exe', Buffer.from('x'), {
      'content-type': 'application/octet-stream',
    })
    expect(url).toContain('/my-bucket/releases/v0.9.1/')
    // 空格必须被编码，不能原样进 URL
    expect(url).not.toContain(' ')
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=A\//)
    expect(headers.Authorization).toContain('/auto/s3/aws4_request')
  })

  it('缺环境变量时给出可读错误', () => {
    const r2 = loadR2()
    expect(() => r2.readConfig({})).toThrow(/CF_ACCOUNT_ID/)
    const cfg = r2.readConfig({
      CF_ACCOUNT_ID: ' a ',
      R2_ACCESS_KEY_ID: ' k ',
      R2_SECRET_ACCESS_KEY: ' s ',
      R2_BUCKET: ' b ',
      R2_PUBLIC_BASE_URL: 'https://dl.example.com/',
    })
    expect(cfg.accountId).toBe('a')
    expect(cfg.bucket).toBe('b')
    expect(cfg.publicBaseUrl).toBe('https://dl.example.com') // 尾斜杠被去掉
  })

  it('publicUrl 在未配置域名时返回 null', () => {
    const r2 = loadR2()
    expect(r2.publicUrl({ publicBaseUrl: '' }, 'k')).toBeNull()
    expect(r2.publicUrl({ publicBaseUrl: 'https://dl.example.com' }, 'a/b.exe')).toBe('https://dl.example.com/a/b.exe')
  })
})
