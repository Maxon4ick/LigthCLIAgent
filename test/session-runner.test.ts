import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { EventBus } from "../src/core/events/event-bus.js"
import type { LLMEvent, ProviderAdapter, ProviderRequest } from "../src/core/llm/provider.js"
import { RulesetPermissionPolicy } from "../src/core/permissions/policy.js"
import { addUserPrompt, createRuntime, createSession } from "../src/core/runtime.js"
import { SessionRunner } from "../src/core/session/session-runner.js"
import { InMemorySessionStore } from "../src/core/session/session-store.js"
import { ToolRegistry } from "../src/core/tools/registry.js"
import type { ToolProvider } from "../src/core/tools/tool.js"

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

  it("feeds tool results into the next provider turn and completes with the final text", async () => {
    let calls = 0
    let secondTurnRoles: string[] = []
    const provider: ProviderAdapter = {
      id: "multi-turn",
      async *stream(input): AsyncIterable<LLMEvent> {
        calls += 1
        if (calls === 1) {
          yield { type: "tool_call", toolCall: { id: "list-1", name: "list_skills", input: {} } }
          yield { type: "done" }
          return
        }
        secondTurnRoles = input.messages.map((message) => message.role)
        expect(input.messages.some((message) =>
          message.parts.some((part) => part.type === "tool_result" && part.toolCallId === "list-1"),
        )).toBe(true)
        yield { type: "text_delta", text: "final from turn two" }
        yield { type: "done" }
      },
    }
    const config = providerConfig("multi-turn", 4)
    const runtime = createRuntime(config, { cwd: process.cwd(), provider })
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "list then answer")

    const result = await runtime.runner.run(session.id)

    expect(calls).toBe(2)
    expect(result).toMatchObject({
      assistantText: "final from turn two",
      stopReason: "completed",
    })
    expect(result.toolResults).toHaveLength(1)
    expect(secondTurnRoles).toEqual(["user", "assistant", "tool"])
    expect(runtime.sessions.listMessages(session.id).map((message) => message.role))
      .toEqual(["user", "assistant", "tool", "assistant"])
  })

  it("stops exactly at the configured iteration limit and marks the session as error", async () => {
    let providerCalls = 0
    const provider: ProviderAdapter = {
      id: "iteration-loop",
      async *stream(): AsyncIterable<LLMEvent> {
        providerCalls += 1
        yield {
          type: "tool_call",
          toolCall: { id: `call-${providerCalls}`, name: "list_skills", input: {} },
        }
        yield { type: "done" }
      },
    }
    const runtime = createRuntime(providerConfig("iteration-loop", 3), {
      cwd: process.cwd(),
      provider,
    })
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "keep going")

    const result = await runtime.runner.run(session.id)

    expect(providerCalls).toBe(3)
    expect(result.stopReason).toBe("iteration_limit")
    expect(result.toolResults).toHaveLength(3)
    expect(result.error).toContain("iteration limit (3)")
    expect(runtime.sessions.getSession(session.id).status).toBe("error")
  })

  it("aborts a running tool, skips later tools, and cancels the session", async () => {
    let firstStartedResolve!: () => void
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve })
    let laterExecutions = 0
    const tools: ToolProvider = {
      id: "abort-tools",
      load: () => [
        {
          name: "wait",
          description: "wait for abort",
          kind: "read",
          metadata: { safeConcurrent: false },
          inputSchema: { type: "object" },
          async execute(_input, context) {
            firstStartedResolve()
            await new Promise<void>((resolve) => {
              if (context.abortSignal.aborted) resolve()
              else context.abortSignal.addEventListener("abort", () => resolve(), { once: true })
            })
            return { ok: false, error: "aborted" }
          },
        },
        {
          name: "later",
          description: "must not execute",
          kind: "read",
          metadata: { safeConcurrent: false },
          inputSchema: { type: "object" },
          async execute() {
            laterExecutions += 1
            return { ok: true }
          },
        },
      ],
    }
    const provider: ProviderAdapter = {
      id: "abort-run",
      async *stream(): AsyncIterable<LLMEvent> {
        yield { type: "tool_call", toolCall: { id: "wait", name: "abort-tools__wait", input: {} } }
        yield { type: "tool_call", toolCall: { id: "later", name: "abort-tools__later", input: {} } }
        yield { type: "done" }
      },
    }
    const runtime = createRuntime(providerConfig("abort-run", 4), {
      cwd: process.cwd(),
      provider,
      toolProviders: [tools],
    })
    await runtime.ready
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "abort tools")
    const run = runtime.startSession(session.id)
    await firstStarted
    runtime.stopSession(session.id, "test")
    const result = await run.promise

    expect(result.stopReason).toBe("cancelled")
    expect(runtime.sessions.getSession(session.id).status).toBe("cancelled")
    expect(laterExecutions).toBe(0)
    expect(result.toolResults).toHaveLength(2)
    expect(result.toolResults.map((item) => item.toolCallId)).toEqual(["wait", "later"])
  })
})

function providerConfig(provider: string, maxIterations: number) {
  return mergeConfig(defaultConfig, {
    model: { provider, model: provider },
    storage: { kind: "memory" },
    agent: { maxIterations },
    models: {
      catalog: [{
        provider,
        model: provider,
        protocol: "mock",
        capabilities: { tools: true, streaming: true, usage: false, reasoning: false, imageInput: false },
      }],
      fallback: { provider, model: provider },
      small: { provider, model: provider },
    },
  })
}

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
