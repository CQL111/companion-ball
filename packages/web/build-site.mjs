// build-site.mjs - 把前台组装进 server/public（与 API 同源部署）
//
// 页面是静态 HTML + 客户端拉接口：
//   - /           首页（一句话 + 此刻的海 + 下载）
//   - /gallery    窗口（潮汐分栏 + 静读模式，全站 noindex）
//   - /download   下载
//   - /privacy /terms  法务（与客户端同源生成）
//
// /news 与 /news/:id 由 Worker 服务端渲染（SEO），不在这里生成。
//
// 用法：npm run build -w @companion/web

import { readdirSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(HERE, 'public')
const OUT = resolve(HERE, '../server/public')

// 只清自己的产物，不碰 server/public/admin（管理后台自己的产物）
for (const f of ['index.html','gallery.html','news.html','download.html','privacy.html','terms.html','sea.js','style.css','_routes.json']) {
  rmSync(join(OUT, f), { force: true })
}
mkdirSync(OUT, { recursive: true })

// 静态源：public/ 下的页面与资源
for (const name of readdirSync(PUBLIC)) {
  cpSync(join(PUBLIC, name), join(OUT, name), { recursive: true })
}

// 注入构建信息（客户端用来显示版本）
const pkg = JSON.parse(readFileSync(join(HERE, '../desktop/package.json'), 'utf8'))
console.log(`✅ 前台已生成 → server/public（桌面端版本 ${pkg.version}）`)

// 提示：法务页来自 docs/legal，由 build:legal 生成；这里只检查
if (!existsSync(join(OUT, 'privacy.html'))) {
  console.warn('⚠ 没有 privacy.html —— 运行 npm run build:legal 生成法务页')
}

writeFileSync(join(OUT, '_routes.json'), JSON.stringify({ version: 1, include: ['/*'], exclude: [] }, null, 2) + '\n')
