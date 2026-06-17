export interface Logger {
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

function write(level: string, message: string, meta?: unknown): void {
  const suffix = meta === undefined ? "" : ` ${JSON.stringify(meta)}`
  process.stderr.write(`[${level}] ${message}${suffix}\n`)
}

export const logger: Logger = {
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta),
}
