// core 内使用的日志接口。平台层传入具体实现；纯 node 单测可传空实现。
export interface Logger {
  info(scope: string, msg: string, meta?: Record<string, unknown>): void
  warn(scope: string, msg: string, meta?: Record<string, unknown>): void
  error(scope: string, msg: string, meta?: Record<string, unknown>): void
  critical(scope: string, msg: string, meta?: Record<string, unknown>): void
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  critical: () => {},
}
