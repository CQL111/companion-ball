// db.ts - 数据访问的最小接口 + 两个适配器（Cloudflare D1 / Node 内置 sqlite）
//
// 业务代码（handler.ts）只依赖 Db，不出现 D1Database。
// 「迁到自己的 VPS」= 换一个适配器，而不是重写业务。
//
// 接口只保留项目实际用到的操作。所有写入都返回 changes（影响行数），
// 业务用它做**原子占位**（例如回信时抢占 reply_id），避免先读后写的竞态。

/** 写入结果：changes = 受影响行数 */
export interface RunResult {
  success: boolean
  changes: number
}

export interface BoundStmt {
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<RunResult>
}

export interface Stmt {
  bind(...params: unknown[]): BoundStmt
}

export interface Db {
  prepare(sql: string): Stmt
  /** 事务性批量执行；失败时整体回滚 */
  batch(stmts: BoundStmt[]): Promise<void>
  /** 关闭底层连接（Node 用；D1 无操作） */
  close?(): void
}

/** 键值计数（限流用） */
export interface RateCounter {
  incr(key: string, ttlSeconds: number): Promise<number>
}

// ---------- Cloudflare D1 适配 ----------

export function d1Adapter(d1: D1Database): Db {
  // 保留「已绑定语句」到原始语句的映射，batch 时用 D1 原生原子批量
  const rawOf = new WeakMap<BoundStmt, D1PreparedStatement>()

  const wrap = (bound: D1PreparedStatement): BoundStmt => {
    const stmt: BoundStmt = {
      first: <T>() => bound.first<T>() as Promise<T | null>,
      all: <T>() => bound.all<T>() as Promise<{ results: T[] }>,
      run: async () => {
        const r = await bound.run()
        return { success: true, changes: Number(r?.meta?.changes ?? 0) }
      },
    }
    rawOf.set(stmt, bound)
    return stmt
  }

  return {
    prepare(sql: string) {
      const prepared = d1.prepare(sql)
      return { bind: (...params: unknown[]) => wrap(prepared.bind(...params)) }
    },
    async batch(stmts: BoundStmt[]) {
      // D1 原生 batch 是原子的；拿不到原始语句时退回串行
      const raws = stmts.map((s) => rawOf.get(s))
      if (raws.every((r) => r !== undefined)) {
        await d1.batch(raws as D1PreparedStatement[])
        return
      }
      for (const s of stmts) await s.run()
    },
  }
}

// ---------- Node 内置 sqlite 适配 ----------
// 运行时需要 Node 22.5+（--experimental-sqlite）或 24+（默认）。
// sqlite 是**同步 API**，但本项目有多处 await，必须显式串行化，
// 否则两条 async 流会交错在同一连接上（读到一个未提交的中间态）。

interface SqliteStatement {
  run(...p: unknown[]): { changes?: number | bigint }
  get(...p: unknown[]): Record<string, unknown> | undefined
  all(...p: unknown[]): Record<string, unknown>[]
}
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  close(): void
}

export function sqliteAdapter(dbPath: string, open: (p: string) => SqliteDatabase): Db {
  const db = open(dbPath)
  // WAL：读写不互相阻塞；busy_timeout：多进程共用同一文件时不立刻抛 locked
  try {
    db.exec('PRAGMA journal_mode=WAL;')
    db.exec('PRAGMA busy_timeout=5000;')
    db.exec('PRAGMA synchronous=NORMAL;')
  } catch {
    /* 只读文件系统等情况忽略 */
  }

  // 单连接串行执行器：所有语句进入同一条 promise 链
  let chain: Promise<unknown> = Promise.resolve()
  function serialize<T>(fn: () => T): Promise<T> {
    const next = chain.then(fn, fn)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const wrap = (sql: string, params: unknown[]): BoundStmt => ({
    first: <T>() => serialize(() => (db.prepare(sql).get(...params) ?? null) as T | null),
    all: <T>() => serialize(() => ({ results: db.prepare(sql).all(...params) as T[] })),
    run: () =>
      serialize(() => {
        const r = db.prepare(sql).run(...params)
        return { success: true, changes: Number(r?.changes ?? 0) }
      }),
  })

  return {
    prepare(sql: string) {
      return { bind: (...params: unknown[]) => wrap(sql, params) }
    },
    async batch(stmts: BoundStmt[]) {
      // BEGIN IMMEDIATE：一开始就拿写锁，避免读锁升级导致的死锁
      await serialize(() => db.exec('BEGIN IMMEDIATE'))
      try {
        for (const s of stmts) await s.run()
        await serialize(() => db.exec('COMMIT'))
      } catch (e) {
        try {
          await serialize(() => db.exec('ROLLBACK'))
        } catch {
          /* 回滚失败时保留原始错误 */
        }
        throw e
      }
    },
    close() {
      try {
        db.close()
      } catch {
        /* ignore */
      }
    },
  }
}
