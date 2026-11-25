// build.mjs - 把服务端打成可直接 node 运行的产物（零第三方依赖用 esbuild）
//
// 为什么需要打包：
//   1. ESM 下相对 import 需要扩展名，源码里写的是 './db'
//   2. 要引用 workspace 的 @companion/contracts 源码（TS）
//   esbuild 把两者内联后，产物是单个 dist/node.mjs，node:sqlite 保持外部引用。
//
// 用法：npm run build -w @companion/server
import { build } from 'esbuild'
import { existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const out = resolve(HERE, 'dist')

rmSync(out, { recursive: true, force: true })

await build({
  entryPoints: [resolve(HERE, 'src/node.ts')],
  outfile: resolve(out, 'node.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // node: 前缀的内置模块保持外部（sqlite / http / crypto）
  external: ['node:*'],
  banner: {
    // 内联的 contracts 是 ESM，产物也按 ESM 输出
    js: '// bundled by esbuild — do not edit',
  },
  logLevel: 'warning',
})

const schema = resolve(HERE, 'schema.sql')
if (!existsSync(schema)) {
  console.error('❌ schema.sql 不存在，运行时会因建表失败退出')
  process.exit(1)
}

console.log(`✅ dist/node.mjs 已生成`)
console.log('   运行：node --experimental-sqlite packages/server/dist/node.mjs')
console.log('   （注意 schema.sql 需与产物同目录的上一级——部署时把它放在 dist/.. 或设 PKG 结构）')
