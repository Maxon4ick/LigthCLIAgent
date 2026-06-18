import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { EventBus } from "../src/core/events/event-bus.js"
import type { LLMEvent, ProviderAdapter, ProviderRequest } from "../src/core/llm/provider.js"
import { RulesetPermissionPolicy } from "../src/core/permissions/policy.js"
import { addUserPrompt, createRuntime, createSession } from "../src/core/runtime.js"
import { SessionRunner } from "../src/core/session/session-runner.js"
import { InMemorySessionStore } from "../src/core/session/session-store.js"
import { ToolRegistry } from "../src/core/tools/registry.js"

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

  it("resolves the provider adapter from the session model", async () => {
    const calls: Array<{ provider: string; model: string }> = []
    const store = new InMemorySessionStore()
    const session = store.createSession({
      cwd: process.cwd(),
      model: { provider: "minimax", model: "MiniMax-M2.1-highspeed" },
    })
    store.addMessage({ sessionId: session.id, role: "user", parts: [{ type: "text", text: "hello" }] })

    const runner = new SessionRunner({
      store,
      eventBus: new EventBus(),
      provider: new RecordingProvider("deepseek", calls),
      providerFactory: (model) => new RecordingProvider(model.provider, calls),
      toolRegistry: new ToolRegistry(),
      permissionPolicy: new RulesetPermissionPolicy({
        allowShell: false,
        allowEdit: false,
        askForShell: false,
        askForEdit: false,
      }),
      config: mergeConfig(memoryConfig, {
        model: { provider: "deepseek", model: "deepseek-v4-flash" },
        models: {
          catalog: [
            ...memoryConfig.models.catalog,
            {
              provider: "minimax",
              model: "MiniMax-M2.1-highspeed",
              protocol: "openai-compatible",
              capabilities: { tools: false, streaming: true, usage: false, reasoning: false, imageInput: false },
            },
          ],
        },
      }),
    })

    const result = await runner.run(session.id)

    expect(result.assistantText).toBe("minimax")
    expect(calls).toEqual([{ provider: "minimax", model: "MiniMax-M2.1-highspeed" }])
  })
})

class RecordingProvider implements ProviderAdapter {
  constructor(
    readonly id: string,
    private readonly calls: Array<{ provider: string; model: string }>,
  ) {}

  async *stream(input: ProviderRequest): AsyncIterable<LLMEvent> {
    this.calls.push({ provider: this.id, model: input.session.model.model })
    yield { type: "text_delta", text: this.id }
    yield { type: "done" }
  }
}
