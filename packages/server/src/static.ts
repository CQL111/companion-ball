// static.ts - Node 运行时的静态资源服务（替代 Cloudflare 的 assets 绑定）
//
// 只在 Node 侧使用：Worker 用 Wrangler assets 绑定，不会引到这里。
// 安全点：路径穿越必须挡住（`..%2f`、绝对路径、符号链接逃逸）。

import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

export interface StaticServer {
  fetch(req: Request): Promise<Response>
}

/**
 * root 是 server/public 的绝对路径。
 * 找不到时：路径看起来像 SPA 路由（/admin/*）就回 index.html，否则 404。
 */
export function createStaticServer(root: string): StaticServer {
  const ROOT = resolve(root)

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      let pathname: string
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        return new Response('bad path', { status: 400 })
      }

      // 归一化并确保不逃出 root
      const rel = normalize(pathname).replace(/^([/\\])+/, '')
      let file = resolve(ROOT, rel)
      if (file !== ROOT && !file.startsWith(ROOT + sep)) {
        return new Response('forbidden', { status: 403 })
      }

      let st = await stat(file).catch(() => null)
      if (st?.isDirectory()) {
        file = join(file, 'index.html')
        st = await stat(file).catch(() => null)
      }

      // SPA 回退：/admin 或 /admin/xxx 回 /admin/index.html
      if (!st && (pathname === '/admin' || pathname.startsWith('/admin/'))) {
        file = join(ROOT, 'admin', 'index.html')
        st = await stat(file).catch(() => null)
      }
      // 首页
      if (!st && pathname === '/') {
        file = join(ROOT, 'index.html')
        st = await stat(file).catch(() => null)
      }
      // 无扩展名的路径 → 试 .html（/gallery → gallery.html）
      if (!st && !extname(pathname)) {
        file = join(ROOT, rel + '.html')
        st = await stat(file).catch(() => null)
      }

      if (!st?.isFile()) return new Response('not found', { status: 404 })

      const body = await readFile(file)
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
      const cache = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'public, max-age=300'
      return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': cache } })
    },
  }
}
