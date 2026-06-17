import http from "node:http"
import type { Runtime } from "../core/runtime.js"
import { handleRoutes } from "./routes.js"

export interface StartedHttpServer {
  url: string
  close(): Promise<void>
}

export async function startHttpServer(runtime: Runtime): Promise<StartedHttpServer> {
  enforceServerExposurePolicy(runtime)
  const server = http.createServer((request, response) => {
    void handleRoutes(runtime, request, response)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(runtime.config.server.port, runtime.config.server.host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === "object" && address ? address.port : runtime.config.server.port
  const host = runtime.config.server.host

  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function enforceServerExposurePolicy(runtime: Runtime): void {
  const host = runtime.config.server.host
  const hasAuth = Boolean(runtime.config.server.authToken)
  if (!isLoopbackHost(host) && !hasAuth) {
    throw new Error("Refusing to start HTTP server on a non-loopback host without server.authToken")
  }

  if (!hasAuth) {
    process.stderr.write("warning: HTTP server auth is disabled; bind is limited to loopback host\n")
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]"
}
