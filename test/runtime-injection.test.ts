import { describe, expect, it } from "vitest"
import { mergeConfig, defaultConfig } from "../src/core/config/schema.js"
import { createRuntime, createSession } from "../src/core/runtime.js"
import { InMemorySessionStore } from "../src/core/session/session-store.js"
import type { SkillSourceProvider } from "../src/core/context/skills.js"
import type { ToolProvider } from "../src/core/tools/tool.js"

const config = () => mergeConfig(defaultConfig, { storage: { kind: "memory" } })

describe("createRuntime dependency injection", () => {
  it("injects tools, skills, store and isolates runtime registries", async () => {
    const store = new InMemorySessionStore()
    const source: SkillSourceProvider = {
      id: "memory",
      discover: () => [{
        id: "memory:guide",
        name: "guide",
        sourceId: "memory",
        location: "memory://guide",
        provenance: "directory",
      }],
      load: (skill) => ({ ...skill, body: "# Guide" }),
    }
    const provider: ToolProvider = {
      id: "team",
      load: () => [{
        name: "echo",
        description: "Echo input",
        kind: "read",
        inputSchema: { type: "object", additionalProperties: false },
        metadata: { capabilities: ["filesystem.read"] },
        execute: async () => ({ ok: true, output: "ok" }),
      }],
    }
    const first = await createRuntime({
      config: config(),
      cwd: process.cwd(),
      sessionStore: store,
      toolProviders: [provider],
      skillSources: [source],
    })
    const second = await createRuntime({ config: config(), cwd: process.cwd() })
    expect(first.sessions).toBe(store)
    expect(createSession(first).id).toBeTruthy()
    expect(first.tools.get("team__echo")).toBeDefined()
    expect(second.tools.get("team__echo")).toBeUndefined()
    await first.dispose()
    await first.dispose()
    await second.dispose()
  })

  it("rolls back initialized providers after a later provider fails", async () => {
    const disposed: string[] = []
    const good: ToolProvider = {
      id: "good",
      load: () => [],
      dispose: () => { disposed.push("good") },
    }
    const bad: ToolProvider = {
      id: "bad",
      load: () => { throw new Error("load failed") },
      dispose: () => { disposed.push("bad") },
    }
    await expect(createRuntime({
      config: config(),
      cwd: process.cwd(),
      toolProviders: [good, bad],
    })).rejects.toThrow("load failed")
    expect(disposed).toEqual(["bad", "good"])
  })
})
