import type { EventBus } from "../events/event-bus.js"
import type { AppConfig, AgentMode } from "../config/schema.js"
import type { PermissionPolicy, PermissionRequest } from "../permissions/policy.js"
import { commandPermissionResources } from "../permissions/shell-command.js"
import { redactSecrets, redactValue } from "../security/redaction.js"
import type { ToolCall } from "../session/message-types.js"
import type { SessionStore } from "../session/session-store.js"
import type { ToolOutputStore } from "./output-store.js"
import type { ToolContext, ToolKind, ToolResult } from "./tool.js"
import type { ToolRegistry } from "./registry.js"

export interface ToolSchedulerOptions {
  registry: ToolRegistry
  permissionPolicy: PermissionPolicy
  eventBus: EventBus
  sessionStore: SessionStore
  config: AppConfig
  maxOutputBytes: number
  maxCaptureBytes: number
  auditLogPath: string
  outputStore?: ToolOutputStore
  runChildSession?: ToolContext["runChildSession"]
}

export interface ToolBatchContext {
  sessionId: string
  assistantMessageId: string
  agentId: string
  agentMode: AgentMode
  cwd: string
  abortSignal: AbortSignal
}

export interface ToolExecution {
  toolCallId: string
  name: string
  ok: boolean
  output?: unknown
  error?: string
}

export class ToolScheduler {
  constructor(private readonly options: ToolSchedulerOptions) {}

  async executeBatch(toolCalls: ToolCall[], context: ToolBatchContext): Promise<ToolExecution[]> {
    const results: ToolExecution[] = []
    let index = 0

    while (index < toolCalls.length) {
      if (context.abortSignal.aborted) {
        break
      }

      const group = this.nextExecutionGroup(toolCalls, index)
      const groupResults = group.parallel
        ? await Promise.all(group.calls.map((toolCall) => this.executeOne(toolCall, context)))
        : [await this.executeOne(group.calls[0] as ToolCall, context)]

      for (const result of groupResults) {
        results.push(result)
        this.options.eventBus.publish({
          type: "tool.result",
          payload: {
            sessionId: context.sessionId,
            messageId: context.assistantMessageId,
            result,
          },
        })
      }
      index += group.calls.length
    }

    return results
  }

  private nextExecutionGroup(toolCalls: ToolCall[], startIndex: number): { parallel: boolean; calls: ToolCall[] } {
    const first = toolCalls[startIndex]
    if (!first || !this.isSafeConcurrent(first)) {
      return {
        parallel: false,
        calls: first ? [first] : [],
      }
    }

    const calls: ToolCall[] = []
    for (let index = startIndex; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index] as ToolCall
      if (!this.isSafeConcurrent(toolCall)) break
      calls.push(toolCall)
    }
    return { parallel: true, calls }
  }

  private isSafeConcurrent(toolCall: ToolCall): boolean {
    const tool = this.options.registry.get(toolCall.name)
    if (!tool) {
      return true
    }
    return tool.metadata?.safeConcurrent ?? (tool.kind === "read" || tool.kind === "search")
  }

  private async executeOne(toolCall: ToolCall, context: ToolBatchContext): Promise<ToolExecution> {
    if (context.abortSignal.aborted) {
      return abortedExecution(toolCall)
    }

    const tool = this.options.registry.get(toolCall.name)
    if (!tool) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        error: `Unknown tool: ${toolCall.name}`,
      }
    }

    if (context.agentMode === "plan" && (tool.kind === "edit" || tool.kind === "execute")) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        error: `Plan mode denies ${tool.kind} tool ${tool.name}`,
      }
    }

    const request = createPermissionRequest(tool.kind, toolCall, context)
    const decision = await this.options.permissionPolicy.decide(request)
    if (context.abortSignal.aborted) {
      return abortedExecution(toolCall)
    }

    if (decision !== "allow") {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        error: `Permission ${decision} for ${tool.kind} tool ${tool.name}`,
      }
    }

    try {
      const toolContext: ToolContext = {
        ...context,
        toolCallId: toolCall.id,
        permissionPolicy: this.options.permissionPolicy,
        config: this.options.config,
        maxOutputBytes: this.options.maxOutputBytes,
        maxCaptureBytes: this.options.maxCaptureBytes,
        auditLogPath: this.options.auditLogPath,
        eventBus: this.options.eventBus,
        sessionStore: this.options.sessionStore,
        runChildSession: this.options.runChildSession,
      }
      const result = await tool.execute(toolCall.input, toolContext)
      return await normalizeResult(toolCall, result, this.options.maxOutputBytes, this.options.outputStore)
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      }
    }
  }
}

function abortedExecution(toolCall: ToolCall): ToolExecution {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    ok: false,
    error: "Tool execution aborted",
  }
}

function createPermissionRequest(kind: ToolKind, toolCall: ToolCall, context: ToolBatchContext): PermissionRequest {
  return {
    sessionId: context.sessionId,
    agentId: context.agentId,
    action: permissionActionForKind(kind),
    resources: resourcesForInput(kind, toolCall.input),
    source: {
      type: "tool",
      toolCallId: toolCall.id,
      messageId: context.assistantMessageId,
    },
  }
}

function permissionActionForKind(kind: ToolKind): PermissionRequest["action"] {
  if (kind === "read") return "read"
  if (kind === "search") return "search"
  if (kind === "execute") return "execute"
  if (kind === "edit") return "edit"
  if (kind === "network") return "network"
  return "read"
}

function resourcesForInput(kind: ToolKind, input: unknown): string[] {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>
    if (typeof record.path === "string") return [record.path]
    if (typeof record.command === "string") {
      return kind === "execute" ? commandPermissionResources(record.command) : [record.command]
    }
    if (typeof record.pattern === "string") return [record.pattern]
    if (typeof record.url === "string") return [record.url]
  }

  return ["unknown"]
}

async function normalizeResult(
  toolCall: ToolCall,
  result: ToolResult,
  maxBytes: number,
  outputStore: ToolOutputStore | undefined,
): Promise<ToolExecution> {
  const output = result.output === undefined ? undefined : await boundValue(toolCall, redactValue(result.output), maxBytes, outputStore)
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    ok: result.ok,
    output,
    error: result.error === undefined ? undefined : redactSecrets(result.error),
  }
}

async function boundValue(
  toolCall: ToolCall,
  value: unknown,
  maxBytes: number,
  outputStore: ToolOutputStore | undefined,
): Promise<unknown> {
  const raw = typeof value === "string" ? value : JSON.stringify(value)
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) {
    return value
  }

  const bytes = Buffer.byteLength(raw, "utf8")
  const outputRef = outputStore
    ? await outputStore.store({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        value,
        bytes,
      })
    : undefined

  return {
    truncated: true,
    bytes,
    preview: raw.slice(0, maxBytes),
    outputRef,
  }
}
