import { startHttpServer } from "./server.js"

export { startHttpServer }
export type { StartedHttpServer } from "./server.js"

export function createHttpAdapter() {
  return { start: startHttpServer }
}
