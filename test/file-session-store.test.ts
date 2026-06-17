import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { addUserPrompt, createRuntime, createSession } from "../src/core/runtime.js"
import { FileSessionStore } from "../src/core/session/file-session-store.js"

describe("FileSessionStore", () => {
  it("persists sessions and messages across runtime instances", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-store-"))
    const config = mergeConfig(defaultConfig, {
      storage: {
        kind: "file",
        path: ".agent-cli/test-sessions.json",
      },
    })

    const firstRuntime = createRuntime(config, cwd)
    const session = createSession(firstRuntime)
    addUserPrompt(firstRuntime, session.id, "hello")
    await firstRuntime.runner.run(session.id)

    const secondRuntime = createRuntime(config, cwd)
    const restoredSession = secondRuntime.sessions.getSession(session.id)
    const restoredMessages = secondRuntime.sessions.listMessages(session.id)

    expect(restoredSession.status).toBe("idle")
    expect(restoredMessages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(restoredMessages[1]?.parts[0]).toMatchObject({
      type: "text",
      text: 'Mock response: received "hello".',
    })
  })

  it("preserves writes from store instances with stale in-memory data", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-store-concurrent-"))
    const storePath = path.join(cwd, ".agent-cli", "test-sessions.json")
    const firstStore = new FileSessionStore(storePath)
    const secondStore = new FileSessionStore(storePath)
    const model = { provider: "mock", model: "mock-agent" }

    const firstSession = firstStore.createSession({ cwd, model, title: "first" })
    const secondSession = secondStore.createSession({ cwd, model, title: "second" })
    secondStore.addMessage({
      sessionId: firstSession.id,
      role: "user",
      parts: [{ type: "text", text: "from second store" }],
    })
    firstStore.addMessage({
      sessionId: secondSession.id,
      role: "user",
      parts: [{ type: "text", text: "from first store" }],
    })

    const restoredStore = new FileSessionStore(storePath)
    expect(restoredStore.listSessions().map((session) => session.id).sort()).toEqual(
      [firstSession.id, secondSession.id].sort(),
    )
    expect(restoredStore.listMessages(firstSession.id).map((message) => message.role)).toEqual(["user"])
    expect(restoredStore.listMessages(secondSession.id).map((message) => message.role)).toEqual(["user"])
  })
})
