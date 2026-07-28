import { describe, expect, it } from "vitest"
import { EventBus } from "../src/core/events/event-bus.js"
import { InMemorySessionStore } from "../src/core/session/session-store.js"
import { ToolRegistry } from "../src/core/tools/registry.js"
import { ToolScheduler } from "../src/core/tools/scheduler.js"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"

describe("tool JSON Schema validation", () => {
  it("compiles schemas at registration and rejects invalid input before permissions and execute", async () => {
    const registry = new ToolRegistry()
    let permissionCalls = 0
    let executions = 0
    registry.register({
      name: "nested",
      description: "Validate nested input",
      kind: "read",
      metadata: { capabilities: ["filesystem.read"] },
      inputSchema: {
        type: "object",
        required: ["items"],
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["kind"],
              properties: { kind: { enum: ["ok"] } },
              additionalProperties: false,
            },
          },
        },
      },
      execute: async () => { executions += 1; return { ok: true } },
    })
    expect(() => registry.register({
      name: "broken",
      description: "Broken schema",
      kind: "read",
      inputSchema: { type: "not-a-json-type" },
      execute: async () => ({ ok: true }),
    })).toThrow("Invalid JSON Schema")
    const store = new InMemorySessionStore()
    const config = mergeConfig(defaultConfig, { storage: { kind: "memory" } })
    const session = store.createSession({ cwd: process.cwd(), model: config.model })
    const scheduler = new ToolScheduler({
      registry,
      permissionPolicy: {
        decide: async () => { permissionCalls += 1; return "allow" },
      },
      eventBus: new EventBus(),
      sessionStore: store,
      config,
      maxOutputBytes: 10_000,
      maxCaptureBytes: 10_000,
      auditLogPath: "audit.log",
    })
    const result = await scheduler.executeBatch(
      [{ id: "bad", name: "nested", input: { items: [{ kind: "no", secret: "test-placeholder" }] } }],
      {
        sessionId: session.id,
        assistantMessageId: "assistant",
        agentId: "default",
        agentMode: "build",
        cwd: process.cwd(),
        abortSignal: new AbortController().signal,
      },
    )
    expect(result[0]?.error).toContain("Invalid input for nested")
    expect(result[0]?.error).not.toContain("test-placeholder")
    expect(permissionCalls).toBe(0)
    expect(executions).toBe(0)
  })
})
