import { mkdir, mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { EventBus } from "../src/core/events/event-bus.js"
import type { LLMEvent, ProviderAdapter } from "../src/core/llm/provider.js"
import {
  RulesetPermissionPolicy,
  type PermissionPolicy,
  type PermissionRequest,
} from "../src/core/permissions/policy.js"
import { addUserPrompt, createRuntime, createSession } from "../src/core/runtime.js"
import { InMemorySessionStore } from "../src/core/session/session-store.js"
import { delegateTaskTool } from "../src/core/tools/builtins/delegate-task.js"
import { ToolRegistry } from "../src/core/tools/registry.js"
import { ToolScheduler } from "../src/core/tools/scheduler.js"
import type { ToolContext, ToolDefinition } from "../src/core/tools/tool.js"

describe("delegate_task", () => {
  it("creates an isolated child and returns its result without shell/edit permission", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-delegate-"))
    await mkdir(path.join(cwd, "child"))
    const config = mergeConfig(defaultConfig, {
      storage: { kind: "memory" },
      permissions: { allowShell: false, allowEdit: false },
    })
    const store = new InMemorySessionStore()
    const parent = store.createSession({
      cwd,
      model: { provider: "parent", model: "parent-model" },
      agentId: "parent-agent",
      mode: "orchestrate",
    })
    const requests: PermissionRequest[] = []
    const policy: PermissionPolicy = {
      async decide(request) {
        requests.push(request)
        return request.action === "agent.delegate" ? "allow" : "deny"
      },
    }
    let childRunId: string | undefined
    const scheduler = createScheduler({
      cwd,
      config,
      store,
      policy,
      tools: [delegateTaskTool, shellLikeTool()],
      runChildSession: async (sessionId) => {
        childRunId = sessionId
        return { ok: true, assistantText: "child answer" }
      },
    })

    const [delegated] = await scheduler.executeBatch([{
      id: "delegate",
      name: "delegate_task",
      input: {
        prompt: "inspect the child task",
        mode: "explore",
        provider: "selected",
        model: "selected-model",
        cwd: "child",
      },
    }], batchContext(parent.id, parent.agentId, cwd, "orchestrate"))

    expect(delegated).toMatchObject({ ok: true, output: "child answer" })
    const child = store.getSession(childRunId ?? "")
    expect(child).toMatchObject({
      parentSessionId: parent.id,
      mode: "explore",
      cwd: path.join(cwd, "child"),
      model: { provider: "selected", model: "selected-model" },
    })
    expect(child.agentId).not.toBe(parent.agentId)
    expect(store.listMessages(child.id)).toMatchObject([
      { role: "user", parts: [{ type: "text", text: "inspect the child task" }] },
    ])
    expect(requests[0]).toMatchObject({ action: "agent.delegate" })
    expect(requests[0]?.resources[0]).toContain("mode:explore/model:selected/selected-model")
    expect(requests[0]?.resources).not.toContain("unknown")

    const [shell] = await scheduler.executeBatch(
      [{ id: "shell", name: "shell_like", input: { command: "echo no" } }],
      batchContext(parent.id, parent.agentId, cwd, "build"),
    )
    expect(shell).toMatchObject({ ok: false })
    expect(shell?.error).toContain("Permission deny")
  })

  it("applies delegate deny before creating a child session", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-delegate-deny-"))
    const config = mergeConfig(defaultConfig, {
      storage: { kind: "memory" },
      permissions: {
        rules: [{ action: "delegate", resource: "*", effect: "deny" }],
      },
    })
    const store = new InMemorySessionStore()
    const parent = store.createSession({ cwd, model: config.model, mode: "orchestrate" })
    const scheduler = createScheduler({
      cwd,
      config,
      store,
      policy: new RulesetPermissionPolicy({
        allowShell: false,
        allowEdit: false,
        askForShell: false,
        askForEdit: false,
        rules: config.permissions.rules,
      }),
      tools: [delegateTaskTool],
      runChildSession: async () => ({ ok: true, assistantText: "must not run" }),
    })

    const [result] = await scheduler.executeBatch(
      [{ id: "deny", name: "delegate_task", input: { prompt: "work" } }],
      batchContext(parent.id, parent.agentId, cwd, "orchestrate"),
    )
    expect(result?.error).toContain("Permission deny")
    expect(store.listSessions()).toHaveLength(1)
  })

  it("returns a child failure as a controlled tool error", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-delegate-error-"))
    const config = mergeConfig(defaultConfig, { storage: { kind: "memory" } })
    const store = new InMemorySessionStore()
    const parent = store.createSession({ cwd, model: config.model, mode: "orchestrate" })
    const scheduler = createScheduler({
      cwd,
      config,
      store,
      policy: allowPolicy(),
      tools: [delegateTaskTool],
      runChildSession: async () => ({ ok: false, assistantText: "", error: "child failed safely" }),
    })

    const [result] = await scheduler.executeBatch(
      [{ id: "child-error", name: "delegate_task", input: { prompt: "fail" } }],
      batchContext(parent.id, parent.agentId, cwd, "orchestrate"),
    )
    expect(result).toMatchObject({ ok: false, error: "child failed safely" })
    expect(store.listSessions()).toHaveLength(2)
  })

  it("enforces the mode matrix before execution and without side effects", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-modes-"))
    const config = mergeConfig(defaultConfig, { storage: { kind: "memory" } })
    const store = new InMemorySessionStore()
    const session = store.createSession({ cwd, model: config.model })
    const effects = { edit: 0, shell: 0, delegate: 0 }
    const edit = effectTool("writer", "edit", () => { effects.edit += 1 })
    const shell = effectTool("shell_like", "execute", () => { effects.shell += 1 })
    const delegate = {
      ...delegateTaskTool,
      execute: async () => {
        effects.delegate += 1
        return { ok: true, output: "delegated" }
      },
    } satisfies ToolDefinition
    const scheduler = createScheduler({
      cwd,
      config,
      store,
      policy: allowPolicy(),
      tools: [edit, shell, delegate],
    })

    for (const mode of ["plan", "explore"] as const) {
      const results = await scheduler.executeBatch([
        { id: `${mode}-edit`, name: "writer", input: {} },
        { id: `${mode}-shell`, name: "shell_like", input: {} },
        { id: `${mode}-delegate`, name: "delegate_task", input: { prompt: "work", mode: "build" } },
      ], batchContext(session.id, session.agentId, cwd, mode))
      expect(results.every((result) => result.ok === false)).toBe(true)
    }

    const orchestrate = await scheduler.executeBatch([
      { id: "orchestrate-edit", name: "writer", input: {} },
      { id: "orchestrate-shell", name: "shell_like", input: {} },
      { id: "orchestrate-delegate", name: "delegate_task", input: { prompt: "work", mode: "build" } },
    ], batchContext(session.id, session.agentId, cwd, "orchestrate"))
    expect(orchestrate.map((result) => result.ok)).toEqual([false, false, true])
    expect(effects).toEqual({ edit: 0, shell: 0, delegate: 1 })

    const build = await scheduler.executeBatch([
      { id: "build-edit", name: "writer", input: {} },
      { id: "build-shell", name: "shell_like", input: {} },
    ], batchContext(session.id, session.agentId, cwd, "build"))
    expect(build.map((result) => result.ok)).toEqual([true, true])
    expect(effects).toEqual({ edit: 1, shell: 1, delegate: 1 })
  })

  it("propagates a parent abort into the running child session", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-delegate-abort-"))
    let childStartedResolve!: () => void
    const childStarted = new Promise<void>((resolve) => { childStartedResolve = resolve })
    const provider: ProviderAdapter = {
      id: "delegating",
      async *stream(input): AsyncIterable<LLMEvent> {
        if (!input.session.parentSessionId) {
          yield {
            type: "tool_call",
            toolCall: { id: "delegate-child", name: "delegate_task", input: { prompt: "wait", mode: "explore" } },
          }
          yield { type: "done" }
          return
        }
        childStartedResolve()
        const signal = input.abortSignal
        if (!signal) throw new Error("child run did not receive an AbortSignal")
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    }
    const config = mergeConfig(defaultConfig, {
      model: { provider: "delegating", model: "delegating" },
      storage: { kind: "memory" },
      models: {
        catalog: [{
          provider: "delegating",
          model: "delegating",
          protocol: "mock",
          capabilities: { tools: true, streaming: true, usage: false, reasoning: false, imageInput: false },
        }],
        fallback: { provider: "delegating", model: "delegating" },
        small: { provider: "delegating", model: "delegating" },
      },
    })
    const runtime = createRuntime(config, { cwd, provider })
    const parent = createSession(runtime, { mode: "orchestrate" })
    addUserPrompt(runtime, parent.id, "delegate")
    const run = runtime.startSession(parent.id)
    await childStarted
    expect(runtime.stopSession(parent.id, "test abort")).toBe(true)
    const result = await run.promise

    expect(result.stopReason).toBe("cancelled")
    expect(runtime.sessions.getSession(parent.id).status).toBe("cancelled")
    const child = runtime.sessions.listSessions().find((candidate) => candidate.parentSessionId === parent.id)
    expect(child?.status).toBe("cancelled")
  })
})

function createScheduler(input: {
  cwd: string
  config: ReturnType<typeof mergeConfig>
  store: InMemorySessionStore
  policy: PermissionPolicy
  tools: ToolDefinition[]
  runChildSession?: ToolContext["runChildSession"]
}): ToolScheduler {
  const registry = new ToolRegistry()
  for (const tool of input.tools) registry.register(tool)
  return new ToolScheduler({
    registry,
    permissionPolicy: input.policy,
    eventBus: new EventBus(),
    sessionStore: input.store,
    config: input.config,
    maxOutputBytes: 10_000,
    maxCaptureBytes: 10_000,
    auditLogPath: path.join(input.cwd, ".agent-cli", "audit.log"),
    runChildSession: input.runChildSession,
  })
}

function batchContext(
  sessionId: string,
  agentId: string,
  cwd: string,
  agentMode: "build" | "plan" | "explore" | "orchestrate",
) {
  return {
    sessionId,
    assistantMessageId: "assistant",
    agentId,
    agentMode,
    cwd,
    abortSignal: new AbortController().signal,
  }
}

function allowPolicy(): PermissionPolicy {
  return { decide: async () => "allow" }
}

function shellLikeTool(): ToolDefinition {
  return effectTool("shell_like", "execute", () => undefined)
}

function effectTool(
  name: string,
  kind: "edit" | "execute",
  effect: () => void,
): ToolDefinition {
  return {
    name,
    description: name,
    kind,
    metadata: { requiresApproval: false, mutatesWorkspace: kind === "edit", safeConcurrent: false },
    inputSchema: { type: "object" },
    async execute() {
      effect()
      return { ok: true }
    },
  }
}
