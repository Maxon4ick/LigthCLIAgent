import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import type { ContextBudgetManager } from "../src/core/context/context-budget.js"
import type { ProviderAdapter } from "../src/core/llm/provider.js"
import { addUserPrompt, createRuntime, createSession, type Runtime } from "../src/core/runtime.js"

function provider(id: string, event: "done" | "tool" | "error"): ProviderAdapter {
  return {
    id,
    async *stream() {
      if (event === "tool") yield { type: "tool_call", toolCall: { id: "call", name: "missing", input: {} } }
      else if (event === "error") yield { type: "error", error: "provider secret sk-test-value" }
      else yield { type: "text_delta", text: "done" }
      yield { type: "done" }
    },
  }
}

function config(id: string, maxIterations = 2) {
  return mergeConfig(defaultConfig, {
    model: { provider: id, model: id },
    storage: { kind: "memory" },
    agent: { maxIterations },
    models: {
      catalog: [{
        provider: id,
        model: id,
        protocol: "mock",
        capabilities: {
          tools: true,
          streaming: true,
          usage: false,
          reasoning: false,
          imageInput: false,
          maxContextTokens: 1_000_000,
        },
      }],
      fallback: { provider: id, model: id },
    },
  })
}

describe("structured run stop reasons", () => {
  it("reports completed, cancelled, iteration, provider, hook, context and runtime errors", async () => {
    const cases: Array<{
      expected: string
      build: () => Promise<Runtime>
      preAbort?: boolean
    }> = [
      {
        expected: "completed",
        build: () => createRuntime({ config: config("complete"), cwd: process.cwd(), provider: provider("complete", "done") }),
      },
      {
        expected: "cancelled",
        preAbort: true,
        build: () => createRuntime({ config: config("cancel"), cwd: process.cwd(), provider: provider("cancel", "done") }),
      },
      {
        expected: "iteration_limit",
        build: () => createRuntime({ config: config("iterate", 1), cwd: process.cwd(), provider: provider("iterate", "tool") }),
      },
      {
        expected: "provider_error",
        build: () => createRuntime({ config: config("provider"), cwd: process.cwd(), provider: provider("provider", "error") }),
      },
      {
        expected: "hook_rejected",
        build: () => createRuntime({
          config: config("hook"),
          cwd: process.cwd(),
          provider: provider("hook", "done"),
          hooks: [{ id: "reject", priority: 0, beforePrompt: () => ({ reject: "no" }) }],
        }),
      },
      {
        expected: "context_limit",
        build: () => createRuntime({
          config: config("context"),
          cwd: process.cwd(),
          provider: provider("context", "done"),
          contextBudget: { prepare: async () => ({
            status: "context_limit",
            messages: [],
            keepLastMessages: 0,
            tokensBefore: 100,
            tokensAfter: 100,
            removedMessages: 0,
          }) },
        }),
      },
      {
        expected: "error",
        build: () => createRuntime({
          config: config("error"),
          cwd: process.cwd(),
          provider: provider("error", "done"),
          contextBudget: {
            prepare: async () => { throw new Error("budget failed") },
          } satisfies ContextBudgetManager,
        }),
      },
    ]
    for (const item of cases) {
      let stops = 0
      const runtime = await item.build()
      runtime.events.subscribe((event) => {
        if (event.type === "session.run.stopped") stops += 1
      })
      const session = createSession(runtime)
      addUserPrompt(runtime, session.id, "hello")
      const controller = new AbortController()
      if (item.preAbort) controller.abort()
      const result = await runtime.runner.run(session.id, controller.signal)
      expect(result.stop.reason).toBe(item.expected)
      expect(stops).toBe(1)
      await runtime.dispose()
    }
  })
})
