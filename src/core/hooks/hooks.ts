import type { SystemContext } from "../context/system-context.js"
import type { EventBus } from "../events/event-bus.js"
import type { Capability } from "../permissions/policy.js"
import { redactSecrets, redactValue } from "../security/redaction.js"
import type { RunStop } from "../run-stop.js"
import type { Message, ToolCall } from "../session/message-types.js"
import type { ToolProvenance } from "../tools/tool.js"
import type { ToolExecution } from "../tools/scheduler.js"

export type HookProvenance = "local" | "bundle" | "host"

export interface BeforePromptResult {
  prompt?: string
  reject?: string
}

export interface BeforeToolResult {
  input?: unknown
  reject?: string
}

export interface AgentHook {
  id: string
  provenance?: HookProvenance
  priority?: number
  /** @deprecated Use priority. */
  order?: number
  beforePrompt?(event: BeforePromptHookContext): Promise<BeforePromptResult | void> | BeforePromptResult | void
  beforeTool?(event: BeforeToolHookContext): Promise<BeforeToolResult | void> | BeforeToolResult | void
  afterTool?(event: AfterToolHookContext): Promise<void> | void
  onStop?(event: RunStopHookContext): Promise<void> | void
  /** @deprecated Use onStop. */
  onRunStop?(event: LegacyRunStopHookContext): Promise<void> | void
  dispose?(): Promise<void> | void
}

/** @deprecated Use AgentHook. */
export type RuntimeHook = AgentHook

export interface HookProvider {
  id: string
  load(): Promise<AgentHook[]> | AgentHook[]
  dispose?(): Promise<void> | void
}

interface BaseHookContext {
  sessionId: string
  runId?: string
  abortSignal: AbortSignal
}

export interface BeforePromptHookContext extends BaseHookContext {
  prompt: string
  messages: readonly Message[]
  systemContext: SystemContext
}

export interface BeforeToolHookContext extends BaseHookContext {
  toolCall: Readonly<ToolCall>
  capabilities: readonly Capability[]
  /** @deprecated Use capabilities. */
  capability: readonly Capability[]
  providerId: string
  provenance: ToolProvenance
}

export interface AfterToolHookContext extends BaseHookContext {
  toolCall: Readonly<ToolCall>
  result: Readonly<ToolExecution>
  providerId: string
  provenance: ToolProvenance
  durationMs: number
  permissionDecision: "allow"
}

export interface RunStopHookContext extends BaseHookContext {
  stop: Readonly<RunStop>
}

export interface LegacyRunStopHookContext extends BaseHookContext {
  stopReason: RunStop["reason"]
}

export class HookRejectedError extends Error {
  constructor(message: string, readonly stage: "beforePrompt" | "beforeTool") {
    super(message)
  }
}

/**
 * Deterministic lifecycle pipeline.
 * beforePrompt/beforeTool fail closed; afterTool/onStop report and continue.
 */
export class HookPipeline {
  private readonly hooks: AgentHook[]
  private disposed = false

  constructor(
    hooks: readonly AgentHook[],
    private readonly events: EventBus,
    private readonly timeoutMs = 5_000,
  ) {
    const ids = new Set<string>()
    for (const hook of hooks) {
      if (!hook.id.trim()) throw new Error("Hook id must be non-empty")
      if (ids.has(hook.id)) throw new Error(`Duplicate hook id "${hook.id}"`)
      ids.add(hook.id)
    }
    this.hooks = [...hooks].sort((left, right) =>
      (left.priority ?? left.order ?? 0) - (right.priority ?? right.order ?? 0) ||
      left.id.localeCompare(right.id),
    )
  }

  async beforePrompt(context: Omit<BeforePromptHookContext, "prompt"> & { prompt?: string }): Promise<Message[]> {
    let prompt = context.prompt ?? latestUserPrompt(context.messages)
    let messages = [...context.messages]
    for (const hook of this.hooks) {
      if (!hook.beforePrompt) continue
      const result = await this.invokeBefore(hook, "beforePrompt", () => hook.beforePrompt?.({
        ...context,
        messages,
        prompt,
      }))
      if (result?.reject) throw new HookRejectedError(redactSecrets(result.reject), "beforePrompt")
      if (result?.prompt !== undefined) {
        prompt = result.prompt
        messages = replaceLatestUserPrompt(messages, prompt)
      }
    }
    return messages
  }

  async beforeTool(context: Omit<BeforeToolHookContext, "capability">): Promise<ToolCall> {
    let toolCall: ToolCall = { ...context.toolCall }
    for (const hook of this.hooks) {
      if (!hook.beforeTool) continue
      const result = await this.invokeBefore(hook, "beforeTool", () => hook.beforeTool?.({
        ...context,
        capability: context.capabilities,
        toolCall,
      }))
      if (result?.reject) throw new HookRejectedError(redactSecrets(result.reject), "beforeTool")
      if (Object.prototype.hasOwnProperty.call(result ?? {}, "input")) {
        toolCall = { ...toolCall, input: result?.input }
      }
    }
    return toolCall
  }

  async afterTool(context: AfterToolHookContext): Promise<void> {
    const boundedContext = {
      ...context,
      toolCall: { ...context.toolCall, input: boundedSummary(redactValue(context.toolCall.input)) },
      result: redactValue(context.result) as ToolExecution,
    }
    for (const hook of this.hooks) {
      if (!hook.afterTool) continue
      await this.invokeObserver(hook, "afterTool", () => hook.afterTool?.(boundedContext), context.sessionId)
    }
  }

  async onStop(context: RunStopHookContext): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.onStop) {
        await this.invokeObserver(hook, "onStop", () => hook.onStop?.(context), context.sessionId)
      } else if (hook.onRunStop) {
        await this.invokeObserver(
          hook,
          "onStop",
          () => hook.onRunStop?.({ ...context, stopReason: context.stop.reason }),
          context.sessionId,
        )
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const hook of [...this.hooks].reverse()) {
      if (!hook.dispose) continue
      await this.invokeObserver(hook, "dispose", () => hook.dispose?.(), "runtime")
    }
  }

  private async invokeBefore<T>(
    hook: AgentHook,
    stage: "beforePrompt" | "beforeTool",
    callback: () => Promise<T> | T,
  ): Promise<T> {
    this.publish("hook.started", hook, stage)
    const started = Date.now()
    try {
      const result = await withTimeout(callback, this.timeoutMs)
      this.publish("hook.finished", hook, stage, Date.now() - started)
      return result
    } catch (error) {
      this.publish("hook.failed", hook, stage, Date.now() - started, error)
      this.events.publish({
        type: "runtime.hook.error",
        payload: {
          sessionId: "runtime",
          hookId: hook.id,
          provenance: hook.provenance ?? "host",
          stage,
          error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        },
      })
      // Deprecated order-based hooks used to be observational. Preserve that
      // behaviour only for legacy hooks; canonical priority-based before hooks
      // remain fail-closed.
      if (hook.priority === undefined && hook.order !== undefined) return undefined as T
      if (error instanceof HookRejectedError) throw error
      throw new HookRejectedError(redactSecrets(error instanceof Error ? error.message : String(error)), stage)
    }
  }

  private async invokeObserver(
    hook: AgentHook,
    stage: "afterTool" | "onStop" | "dispose",
    callback: () => Promise<unknown> | unknown,
    sessionId: string,
  ): Promise<void> {
    this.publish("hook.started", hook, stage, undefined, undefined, sessionId)
    const started = Date.now()
    try {
      await withTimeout(callback, this.timeoutMs)
      this.publish("hook.finished", hook, stage, Date.now() - started, undefined, sessionId)
    } catch (error) {
      this.publish("hook.failed", hook, stage, Date.now() - started, error, sessionId)
    }
  }

  private publish(
    type: "hook.started" | "hook.finished" | "hook.failed",
    hook: AgentHook,
    stage: string,
    durationMs?: number,
    error?: unknown,
    sessionId?: string,
  ): void {
    this.events.publish({
      type,
      payload: {
        sessionId,
        hookId: hook.id,
        provenance: hook.provenance ?? "host",
        stage,
        durationMs,
        error: error === undefined
          ? undefined
          : redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      },
    })
  }
}

function latestUserPrompt(messages: readonly Message[]): string {
  const message = [...messages].reverse().find((item) => item.role === "user")
  return message?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? ""
}

function replaceLatestUserPrompt(messages: readonly Message[], prompt: string): Message[] {
  const result = [...messages]
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index]
    if (message?.role !== "user") continue
    result[index] = {
      ...message,
      parts: [{ type: "text", text: prompt }],
    }
    return result
  }
  return result
}

function boundedSummary(value: unknown): unknown {
  const serialized = typeof value === "string" ? value : JSON.stringify(value)
  if (serialized.length <= 2_000) return value
  return { truncated: true, preview: serialized.slice(0, 2_000), characters: serialized.length }
}

async function withTimeout<T>(callback: () => Promise<T> | T, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(callback),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Hook timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
