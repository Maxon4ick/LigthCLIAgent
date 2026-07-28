import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { loadSkillIndex, workspaceSkillSources } from "../src/core/context/skills.js"
import { installBundle } from "../src/core/context/bundle-install.js"
import { EventBus } from "../src/core/events/event-bus.js"
import type { LLMEvent, ProviderAdapter, ProviderRequest } from "../src/core/llm/provider.js"
import { RulesetPermissionPolicy } from "../src/core/permissions/policy.js"
import { addUserPrompt, createRuntime, createSession } from "../src/core/runtime.js"
import { InMemorySessionStore } from "../src/core/session/session-store.js"
import { delegateTaskTool } from "../src/core/tools/builtins/delegate-task.js"
import { ToolRegistry } from "../src/core/tools/registry.js"
import { ToolScheduler } from "../src/core/tools/scheduler.js"
import type { ToolDefinition, ToolProvider } from "../src/core/tools/tool.js"

describe("runtime extension architecture", () => {
  it("indexes more than 20 skills and diagnoses duplicate names by source priority", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-index-"))
    for (let index = 0; index < 23; index += 1) {
      const dir = path.join(cwd, "low", `skill-${String(index).padStart(2, "0")}`)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, "SKILL.md"), `---\nname: skill-${index}\n---\n# Skill ${index}\n`, "utf8")
    }
    await mkdir(path.join(cwd, "high", "winner"), { recursive: true })
    await writeFile(path.join(cwd, "low", "skill-00", "SKILL.md"), "---\nname: duplicate\n---\n# Low\n", "utf8")
    await writeFile(path.join(cwd, "high", "winner", "SKILL.md"), "---\nname: duplicate\n---\n# High\n", "utf8")

    const index = await loadSkillIndex(cwd, [
      { id: "high", root: "high", priority: 10 },
      { id: "low", root: "low", priority: 1 },
    ])

    expect(index.skills).toHaveLength(23)
    expect(index.skills.find((skill) => skill.name === "duplicate")?.sourceId).toBe("high")
    expect(index.diagnostics.filter((item) => item.code === "duplicate")).toHaveLength(1)
  })

  it("loads a skill omitted from a compact prompt catalog through use_skill", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-use-skill-"))
    for (let index = 0; index < 22; index += 1) {
      const dir = path.join(cwd, ".agents", "skills", `s-${index}`)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, "SKILL.md"), `---\nname: s-${index}\ndescription: skill ${index}\n---\n# S\nbody ${index}\n`, "utf8")
    }
    const runtime = createRuntime(mergeConfig(defaultConfig, {
      storage: { kind: "memory" },
      agent: { skillPromptMaxChars: 120 },
    }), cwd)
    const session = createSession(runtime)
    const system = await import("../src/core/context/system-context.js").then(({ materializeSystemContext }) =>
      materializeSystemContext(session, runtime.config, workspaceSkillSources(runtime.config.agent.skillPaths)),
    )
    expect(system.text).toContain("total 22; shown fully 0; shortened 0; not shown 22")
    expect(system.text).toContain("full list is available through list_skills")

    const tool = runtime.tools.get("use_skill")
    const result = await tool?.execute({ name: "s-21" }, toolContext(cwd, runtime))
    expect(result?.ok).toBe(true)
    expect(JSON.stringify(result?.output)).toContain("body 21")
  })

  it("injects namespaced tool providers, validates schemas, and reports conflicts", async () => {
    let externalWriteRan = false
    const provider: ToolProvider = {
      id: "custom",
      load: async () => [
        {
          name: "echo",
          description: "Echo text",
          kind: "read",
          inputSchema: {
            type: "object",
            required: ["text"],
            properties: { text: { type: "string" } },
            additionalProperties: false,
          },
          execute: async (input) => ({ ok: true, output: input }),
        },
        {
          name: "write",
          description: "Mutate",
          kind: "edit",
          inputSchema: { type: "object" },
          execute: async () => {
            externalWriteRan = true
            return { ok: true }
          },
        },
      ],
    }
    const runtime = createRuntime(mergeConfig(defaultConfig, { storage: { kind: "memory" } }), {
      cwd: process.cwd(),
      toolProviders: [provider],
    })
    await runtime.ready
    expect(runtime.tools.list().find((tool) => tool.name === "custom__echo")?.metadata).toMatchObject({
      providerId: "custom",
      provenance: "local",
    })

    const invalid = await scheduler(runtime.tools, runtime).executeBatch(
      [{ id: "bad", name: "custom__echo", input: {} }],
      batchContext(process.cwd()),
    )
    expect(invalid[0]?.error).toContain("$.text is required")
    const deniedWrite = await scheduler(runtime.tools, runtime).executeBatch(
      [{ id: "write", name: "custom__write", input: {} }],
      batchContext(process.cwd()),
    )
    expect(deniedWrite[0]?.error).toBe("Permission deny for edit tool custom__write")
    expect(externalWriteRan).toBe(false)

    const conflict = createRuntime(mergeConfig(defaultConfig, { storage: { kind: "memory" } }), {
      cwd: process.cwd(),
      toolProviders: [provider, { ...provider, id: "other", namespace: "custom" }],
    })
    await expect(conflict.ready).rejects.toThrow('Tool name conflict: "custom__echo"')
  })

  it("allows delegation without shell and enforces mode capability boundaries", async () => {
    const registry = new ToolRegistry()
    registry.register(delegateTaskTool)
    registry.register({
      name: "shell_like",
      description: "process",
      kind: "execute",
      inputSchema: { type: "object" },
      execute: async () => ({ ok: true }),
    })
    registry.register({
      name: "writer",
      description: "write",
      kind: "edit",
      inputSchema: { type: "object" },
      execute: async () => ({ ok: true }),
    })
    const config = mergeConfig(defaultConfig, { storage: { kind: "memory" } })
    const store = new InMemorySessionStore()
    const toolScheduler = new ToolScheduler({
      registry,
      permissionPolicy: new RulesetPermissionPolicy({
        allowShell: false, allowEdit: false, askForShell: false, askForEdit: false,
      }),
      eventBus: new EventBus(),
      sessionStore: store,
      config,
      maxOutputBytes: 1_000,
      maxCaptureBytes: 1_000,
      auditLogPath: path.join(process.cwd(), ".agent-cli", "audit.log"),
      runChildSession: async () => ({ assistantText: "child", ok: true }),
    })
    const parent = store.createSession({
      cwd: process.cwd(),
      model: config.model,
      mode: "orchestrate",
    })
    const delegated = await toolScheduler.executeBatch(
      [{ id: "delegate", name: "delegate_task", input: { prompt: "work" } }],
      { ...batchContext(process.cwd()), sessionId: parent.id, agentMode: "orchestrate" },
    )
    expect(delegated[0]).toMatchObject({ ok: true, output: "child" })

    const direct = await toolScheduler.executeBatch(
      [{ id: "shell", name: "shell_like", input: {} }],
      { ...batchContext(process.cwd()), sessionId: parent.id, agentMode: "orchestrate" },
    )
    expect(direct[0]?.error).toContain("orchestrate mode denies capability process.execute")

    const planWrite = await toolScheduler.executeBatch(
      [{ id: "write", name: "writer", input: {} }],
      { ...batchContext(process.cwd()), sessionId: parent.id, agentMode: "plan" },
    )
    expect(planWrite[0]?.error).toContain("plan mode denies capability filesystem.write")

    const atDepthLimit = await toolScheduler.executeBatch(
      [{ id: "deep", name: "delegate_task", input: { prompt: "too deep" } }],
      {
        ...batchContext(process.cwd()),
        sessionId: parent.id,
        agentMode: "orchestrate",
        delegationDepth: config.agent.maxDelegationDepth,
      },
    )
    expect(atDepthLimit[0]?.error).toContain("maximum delegation depth")

    const controller = new AbortController()
    let childObservedAbort = false
    let childStartedResolve!: () => void
    const childStarted = new Promise<void>((resolve) => { childStartedResolve = resolve })
    const abortScheduler = new ToolScheduler({
      registry,
      permissionPolicy: new RulesetPermissionPolicy({
        allowShell: false, allowEdit: false, askForShell: false, askForEdit: false,
      }),
      eventBus: new EventBus(),
      sessionStore: store,
      config,
      maxOutputBytes: 1_000,
      maxCaptureBytes: 1_000,
      auditLogPath: path.join(process.cwd(), ".agent-cli", "audit.log"),
      runChildSession: async (_sessionId, signal) => new Promise((resolve) => {
        childStartedResolve()
        signal.addEventListener("abort", () => {
          childObservedAbort = true
          resolve({ assistantText: "", ok: false, error: "aborted" })
        }, { once: true })
      }),
    })
    const pending = abortScheduler.executeBatch(
      [{ id: "abort-child", name: "delegate_task", input: { prompt: "wait" } }],
      {
        ...batchContext(process.cwd()),
        sessionId: parent.id,
        agentMode: "orchestrate",
        abortSignal: controller.signal,
      },
    )
    await childStarted
    controller.abort(new Error("parent stopped"))
    await pending
    expect(childObservedAbort).toBe(true)
  })

  it("returns iteration_limit and uses fallback only for transient provider errors", async () => {
    let toolCall = 0
    const looping: ProviderAdapter = {
      id: "loop",
      async *stream(): AsyncIterable<LLMEvent> {
        toolCall += 1
        yield { type: "tool_call", toolCall: { id: `call-${toolCall}`, name: "list_skills", input: {} } }
        yield { type: "done" }
      },
    }
    const loopRuntime = createRuntime(mergeConfig(defaultConfig, {
      model: { provider: "loop", model: "loop" },
      storage: { kind: "memory" },
      agent: { maxIterations: 2 },
      models: {
        catalog: [{
          provider: "loop", model: "loop", protocol: "mock",
          capabilities: { tools: true, streaming: true, usage: false, reasoning: false, imageInput: false },
        }],
        fallback: { provider: "loop", model: "loop" },
      },
    }), { cwd: process.cwd(), provider: looping })
    const loopSession = createSession(loopRuntime)
    addUserPrompt(loopRuntime, loopSession.id, "loop")
    const limited = await loopRuntime.runner.run(loopSession.id)
    expect(limited.stopReason).toBe("iteration_limit")
    expect(limited.toolResults).toHaveLength(2)

    let fallbackCalls = 0
    const primary = failingProvider("primary", 503)
    const fallback: ProviderAdapter = {
      id: "fallback",
      async *stream() {
        fallbackCalls += 1
        yield { type: "text_delta", text: "recovered" } as LLMEvent
        yield { type: "done" } as LLMEvent
      },
    }
    const fallbackRuntime = runtimeWithFallback(primary, fallback)
    const fallbackSession = createSession(fallbackRuntime)
    const recovered = await fallbackRuntime.runner.run(fallbackSession.id)
    expect(recovered).toMatchObject({ stopReason: "completed", assistantText: "recovered" })
    expect(fallbackCalls).toBe(1)

    fallbackCalls = 0
    const rejectedRuntime = runtimeWithFallback(failingProvider("primary", 400), fallback)
    const rejectedSession = createSession(rejectedRuntime)
    const rejected = await rejectedRuntime.runner.run(rejectedSession.id)
    expect(rejected.stopReason).toBe("error")
    expect(fallbackCalls).toBe(0)
  })

  it("isolates host hook errors while bundle installation leaves Claude settings untouched", async () => {
    const calls: string[] = []
    const runtime = createRuntime(mergeConfig(defaultConfig, { storage: { kind: "memory" } }), {
      cwd: process.cwd(),
      hooks: [
        { id: "later", provenance: "host", order: 2, beforePrompt: () => { calls.push("later") } },
        {
          id: "broken",
          provenance: "local",
          order: 1,
          beforePrompt: () => { calls.push("broken"); throw new Error("hook boom") },
        },
        { id: "stop", provenance: "host", onRunStop: () => { calls.push("stop") } },
      ],
    })
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "hello")
    const result = await runtime.runner.run(session.id)
    expect(result.stopReason).toBe("completed")
    expect(calls).toEqual(["broken", "later", "stop"])
    expect(runtime.events.history().some((event) => event.type === "runtime.hook.error")).toBe(true)

    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-bundle-safe-"))
    const bundle = path.join(cwd, "bundle")
    await mkdir(path.join(bundle, "hooks"), { recursive: true })
    await writeFile(path.join(bundle, "hooks", "check.sh"), "# check - Stop hook.\n", "utf8")
    await installBundle(bundle, path.join(cwd, ".agents", "skills"), cwd)
    await expect(stat(path.join(cwd, ".claude", "settings.local.json"))).rejects.toMatchObject({ code: "ENOENT" })

    await mkdir(path.join(cwd, ".claude"), { recursive: true })
    await writeFile(path.join(cwd, ".claude", "settings.local.json"), "{broken", "utf8")
    await expect(installBundle(bundle, path.join(cwd, ".agents", "skills"), cwd)).resolves.toMatchObject({
      hooksDetected: 1,
      inactiveComponents: ["hooks"],
    })
    await expect(readFile(path.join(cwd, ".claude", "settings.local.json"), "utf8")).resolves.toBe("{broken")
  })

  it("compacts context without separating assistant tool calls from tool results", async () => {
    let seenMessages: ProviderRequest["messages"] = []
    const provider: ProviderAdapter = {
      id: "capture",
      async *stream(input) {
        seenMessages = input.messages
        yield { type: "text_delta", text: "done" } as LLMEvent
        yield { type: "done" } as LLMEvent
      },
    }
    const config = mergeConfig(defaultConfig, {
      model: { provider: "capture", model: "tiny" },
      storage: { kind: "memory" },
      agent: { compactMaxMessages: 1 },
      models: {
        catalog: [{
          provider: "capture",
          model: "tiny",
          protocol: "mock",
          capabilities: {
            tools: false,
            streaming: true,
            usage: false,
            reasoning: false,
            imageInput: false,
            maxContextTokens: 100,
          },
        }],
        fallback: { provider: "capture", model: "tiny" },
      },
    })
    const runtime = createRuntime(config, { cwd: process.cwd(), provider })
    const session = createSession(runtime)
    for (let index = 0; index < 6; index += 1) {
      runtime.sessions.addMessage({
        sessionId: session.id,
        role: "assistant",
        parts: [{ type: "tool_call", toolCallId: `pair-${index}`, name: "read_file", input: { path: "x" } }],
      })
      runtime.sessions.addMessage({
        sessionId: session.id,
        role: "tool",
        parts: [{ type: "tool_result", toolCallId: `pair-${index}`, name: "read_file", output: "x" }],
      })
    }

    const result = await runtime.runner.run(session.id)
    expect(result.stopReason).toBe("completed")
    const calls = new Set(seenMessages.flatMap((message) =>
      message.parts.filter((part) => part.type === "tool_call").map((part) => part.toolCallId),
    ))
    const results = seenMessages.flatMap((message) =>
      message.parts.filter((part) => part.type === "tool_result").map((part) => part.toolCallId),
    )
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((id) => calls.has(id))).toBe(true)
  })
})

function batchContext(cwd: string) {
  return {
    sessionId: "session",
    assistantMessageId: "assistant",
    agentId: "agent",
    agentMode: "build" as const,
    cwd,
    abortSignal: new AbortController().signal,
  }
}

function scheduler(registry: ToolRegistry, runtime: ReturnType<typeof createRuntime>): ToolScheduler {
  return new ToolScheduler({
    registry,
    permissionPolicy: runtime.approvals,
    eventBus: runtime.events,
    sessionStore: runtime.sessions,
    config: runtime.config,
    maxOutputBytes: 1_000,
    maxCaptureBytes: 1_000,
    auditLogPath: path.join(runtime.cwd, ".agent-cli", "audit.log"),
  })
}

function toolContext(cwd: string, runtime: ReturnType<typeof createRuntime>) {
  return {
    ...batchContext(cwd),
    toolCallId: "tool",
    permissionPolicy: runtime.approvals,
    config: runtime.config,
    maxOutputBytes: 1_000,
    auditLogPath: path.join(cwd, ".agent-cli", "audit.log"),
    eventBus: runtime.events,
    sessionStore: runtime.sessions,
  }
}

function failingProvider(id: string, status: number): ProviderAdapter {
  return {
    id,
    async *stream(): AsyncIterable<LLMEvent> {
      throw new Error(`request failed (${status})`)
    },
  }
}

function runtimeWithFallback(primary: ProviderAdapter, fallback: ProviderAdapter) {
  const config = mergeConfig(defaultConfig, {
    model: { provider: "primary", model: "one" },
    storage: { kind: "memory" },
    models: {
      catalog: [
        {
          provider: "primary", model: "one", protocol: "mock",
          capabilities: { tools: false, streaming: true, usage: false, reasoning: false, imageInput: false },
        },
        {
          provider: "fallback", model: "two", protocol: "mock",
          capabilities: { tools: false, streaming: true, usage: false, reasoning: false, imageInput: false },
        },
      ],
      fallback: { provider: "fallback", model: "two" },
    },
  })
  return createRuntime(config, {
    cwd: process.cwd(),
    provider: primary,
    providerFactory: (model) => model.provider === "fallback" ? fallback : primary,
  })
}
