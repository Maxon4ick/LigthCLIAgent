import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { addUserPrompt, createRuntime, createSession } from "../src/core/runtime.js"

const memoryConfig = mergeConfig(defaultConfig, { storage: { kind: "memory" } })

describe("SessionRunner", () => {
  it("runs a mock prompt and returns to idle", async () => {
    const runtime = createRuntime(memoryConfig, process.cwd())
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "hello")

    const result = await runtime.runner.run(session.id)

    expect(result.assistantText).toContain("Mock response")
    expect(result.toolResults).toEqual([])
    expect(runtime.sessions.getSession(session.id).status).toBe("idle")
  })

  it("executes a mock read_file tool call", async () => {
    const runtime = createRuntime(memoryConfig, process.cwd())
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "read package.json")

    const result = await runtime.runner.run(session.id)

    expect(result.toolResults).toHaveLength(1)
    expect(result.toolResults[0]?.name).toBe("read_file")
    expect(result.toolResults[0]?.ok).toBe(true)
  })
})
