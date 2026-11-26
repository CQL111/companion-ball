import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@companion/contracts': resolve(__dirname, '../contracts/src/index.ts'),
      '@companion/contracts/': resolve(__dirname, '../contracts/src') + '/',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // node:sqlite 是 Node 内置模块，需要实验标志（Node 22）
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--experimental-sqlite'] } },
  },
})
