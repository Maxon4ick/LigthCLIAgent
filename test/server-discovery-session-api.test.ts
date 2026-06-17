import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { addUserPrompt, createRuntime, createSession } from "../src/core/runtime.js"
import { startHttpServer } from "../src/server/http-server.js"

describe("HTTP daemon discovery and session APIs", () => {
  it("exposes tools, models, OpenAPI metadata, and session workflow endpoints", async () => {
    const runtime = createRuntime(
      mergeConfig(defaultConfig, {
        server: { port: 0 },
        storage: { kind: "memory" },
      }),
      process.cwd(),
    )
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "hello")
    addUserPrompt(runtime, session.id, "second")
    const server = await startHttpServer(runtime)

    try {
      const tools = (await (await fetch(`${server.url}/tools`)).json()) as { tools: Array<{ name: string }> }
      expect(tools.tools.map((tool) => tool.name)).toContain("write_file")
      expect(tools.tools.map((tool) => tool.name)).toContain("glob")

      const models = (await (await fetch(`${server.url}/models`)).json()) as { current: { ref: { provider: string } } }
      expect(models.current.ref.provider).toBe("mock")

      const openapi = (await (await fetch(`${server.url}/openapi.json`)).json()) as { paths: Record<string, unknown> }
      expect(openapi.paths["/sessions/{sessionId}/fork"]).toBeDefined()
      expect(openapi.paths["/sessions/{sessionId}/abort"]).toBeDefined()

      const patched = await fetch(`${server.url}/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Main thread", mode: "plan" }),
      })
      expect(patched.status).toBe(200)
      expect(runtime.sessions.getSession(session.id)).toMatchObject({ title: "Main thread", mode: "plan" })

      const forked = (await (
        await fetch(`${server.url}/sessions/${session.id}/fork`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Forked" }),
        })
      ).json()) as { session: { id: string; parentSessionId: string } }
      expect(forked.session.parentSessionId).toBe(session.id)
      expect(runtime.sessions.listMessages(forked.session.id)).toHaveLength(2)

      const compacted = (await (
        await fetch(`${server.url}/sessions/${session.id}/compact`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ summary: "manual summary", keepLastMessages: 1 }),
        })
      ).json()) as { removedMessages: number; session: { summary: string } }
      expect(compacted.removedMessages).toBe(1)
      expect(compacted.session.summary).toBe("manual summary")

      const runSession = (await (await fetch(`${server.url}/sessions`, { method: "POST" })).json()) as {
        session: { id: string }
      }
      const promptResponse = (await (
        await fetch(`${server.url}/sessions/${runSession.session.id}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "hello" }),
        })
      ).json()) as { runId: string }
      expect(promptResponse.runId).toMatch(/^run_/)
      await waitForRun(runtime, runSession.session.id)

      const runEvents = runtime.events.history({ sessionId: runSession.session.id })
      expect(runEvents[0]).toMatchObject({ version: 1, sequence: expect.any(Number) })
      expect(runEvents.map((event) => event.type)).toContain("session.run.started")
      expect(runEvents.map((event) => event.type)).toContain("session.run.finished")
    } finally {
      await server.close()
    }
  })
})

async function waitForRun(runtime: ReturnType<typeof createRuntime>, sessionId: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (!runtime.runs.get(sessionId) && runtime.sessions.getSession(sessionId).status !== "running") {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  throw new Error("Timed out waiting for run to finish")
}
