import { describe, expect, it } from "vitest"
import type { AppConfig } from "../src/core/config/schema.js"
import { defaultConfig } from "../src/core/config/schema.js"
import { createRuntime } from "../src/core/runtime.js"
import { startHttpServer } from "../src/server/http-server.js"

describe("HTTP daemon auth", () => {
  it("keeps health public and protects session routes when bearer auth is configured", async () => {
    const config: AppConfig = {
      ...defaultConfig,
      server: {
        ...defaultConfig.server,
        port: 0,
        authToken: "secret-token",
      },
      storage: {
        kind: "memory",
        path: defaultConfig.storage.path,
        dbPath: defaultConfig.storage.dbPath,
      },
    }
    const runtime = createRuntime(config, process.cwd())
    const server = await startHttpServer(runtime)

    try {
      const health = await fetch(`${server.url}/health`)
      expect(health.status).toBe(200)

      const capabilities = (await (await fetch(`${server.url}/capabilities`)).json()) as { features: string[] }
      expect(capabilities.features).toContain("bearer_auth")

      const denied = await fetch(`${server.url}/sessions`)
      expect(denied.status).toBe(401)

      const created = await fetch(`${server.url}/sessions`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
        },
      })
      expect(created.status).toBe(201)
    } finally {
      await server.close()
    }
  })
})
