// build.mjs - 把服务端打成可直接 node 运行的产物（零第三方依赖用 esbuild）
//
// 为什么需要打包：
//   1. ESM 下相对 import 需要扩展名，源码里写的是 './db'
//   2. 要引用 workspace 的 @companion/contracts 源码（TS）
//   esbuild 把两者内联后，产物是单个 dist/node.mjs，node:sqlite 保持外部引用。
//
// 产物结构（dist/ 就是可直接拷到 VPS 的部署包）：
//   dist/
//   ├── node.mjs        ← 服务端
//   ├── migrations/     ← 与 D1 共用的迁移文件
//   └── public/         ← 前台 + 管理后台的静态产物（同源部署）
//
// 用法：npm run build -w @companion/server

import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const out = resolve(HERE, 'dist')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  entryPoints: [resolve(HERE, 'src/node.ts')],
  outfile: resolve(out, 'node.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // node: 前缀的内置模块保持外部（sqlite / http / crypto / fs）
  external: ['node:*'],
  banner: {
    // 内联的 contracts 是 ESM，产物也按 ESM 输出
    js: '// bundled by esbuild — do not edit',
  },
  logLevel: 'warning',
})

// 迁移：Node 运行时按序执行（与 D1 共用同一套文件）
const migrationsDir = resolve(HERE, 'migrations')
if (!existsSync(migrationsDir)) {
  console.error('❌ migrations/ 不存在，运行时会因建表失败退出')
  process.exit(1)
}
cpSync(migrationsDir, join(out, 'migrations'), { recursive: true })
const migrationCount = readdirSync(join(out, 'migrations')).filter((f) => f.endsWith('.sql')).length

// 静态资源：前台 + 管理后台（同源部署，见 docs/PLATFORM.md 第三节）
const publicDir = resolve(HERE, 'public')
let staticFiles = 0
if (existsSync(publicDir)) {
  cpSync(publicDir, join(out, 'public'), { recursive: true })
  staticFiles = readdirSync(join(out, 'public')).length
} else {
  console.warn('⚠ public/ 不存在：前台与后台将不可访问。')
  console.warn('  先运行：npm run build -w @companion/web && npm run build -w @companion/admin')
}

console.log(`✅ 服务端产物 → dist/`)
console.log(`   node.mjs · ${migrationCount} 个迁移 · public/（${staticFiles} 项）`)
console.log('   运行：node --experimental-sqlite dist/node.mjs   （Node 24+ 无需标志）')
