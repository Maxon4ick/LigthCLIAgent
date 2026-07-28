import type { EventBus } from "../events/event-bus.js"
import type { AppConfig, AgentMode } from "../config/schema.js"
import type {
  Capability,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
} from "../permissions/policy.js"
import { commandPermissionResources } from "../permissions/shell-command.js"
import { redactSecrets, redactValue } from "../security/redaction.js"
import type { ToolCall } from "../session/message-types.js"
import type { SessionStore } from "../session/session-store.js"
import type { ToolOutputStore } from "./output-store.js"
import type { ToolContext, ToolKind, ToolResult } from "./tool.js"
import type { ToolRegistry } from "./registry.js"
import { capabilitiesForDefinition } from "./registry.js"
import { validateCompiledJsonSchema } from "./json-schema.js"
import type { HookPipeline } from "../hooks/hooks.js"
import type { SkillSource } from "../context/skills.js"

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
  hooks?: HookPipeline
  skillSources?: readonly SkillSource[]
}

export interface ToolBatchContext {
  sessionId: string
  assistantMessageId: string
  agentId: string
  agentMode: AgentMode
  cwd: string
  abortSignal: AbortSignal
  delegationDepth?: number
}

export interface ToolExecution {
  toolCallId: string
  name: string
  ok: boolean
  output?: unknown
  error?: string
  errorCode?: "hook_rejected"
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
    const registered = this.options.registry.getRegistered(toolCall.name)
    const tool = registered?.definition
    if (!tool || !registered) {
      return true
    }
    return tool.metadata?.safeConcurrent ?? (tool.kind === "read" || tool.kind === "search")
  }

  private async executeOne(toolCall: ToolCall, context: ToolBatchContext): Promise<ToolExecution> {
    if (context.abortSignal.aborted) {
      return abortedExecution(toolCall)
    }

    const registered = this.options.registry.getRegistered(toolCall.name)
    const tool = registered?.definition
    if (!tool || !registered) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        error: `Unknown tool: ${toolCall.name}`,
      }
    }

    const validation = validateCompiledJsonSchema(registered.validator, toolCall.input)
    if (!validation.valid) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        error: `Invalid input for ${tool.name}: ${validation.errors.join("; ")}`,
      }
    }

    const capabilities = capabilitiesForDefinition(tool)
    let finalToolCall = toolCall
    try {
      finalToolCall = await this.options.hooks?.beforeTool({
        sessionId: context.sessionId,
        toolCall,
        capabilities,
        providerId: registered.providerId,
        provenance: registered.provenance,
        abortSignal: context.abortSignal,
      }) ?? toolCall
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        error: `Tool hook rejected ${tool.name}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        errorCode: "hook_rejected",
      }
    }
    const transformedValidation = validateCompiledJsonSchema(registered.validator, finalToolCall.input)
    if (!transformedValidation.valid) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        error: `Invalid input for ${tool.name}: ${transformedValidation.errors.join("; ")}`,
      }
    }
    const modeDenial = modeDenialReason(context.agentMode, tool, finalToolCall.input)
    if (modeDenial) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        error: modeDenial,
      }
    }

    for (const capability of capabilities) {
      const request = createPermissionRequest(
        capability,
        tool.kind,
        finalToolCall,
        context,
        tool.metadata?.requiresApproval === true,
      )
      const cancelPending = () => {
        this.options.permissionPolicy.denyPendingForSession?.(context.sessionId)
      }
      context.abortSignal.addEventListener("abort", cancelPending, { once: true })
      let decision: PermissionDecision
      try {
        decision = await this.options.permissionPolicy.decide(request, context.abortSignal)
      } finally {
        context.abortSignal.removeEventListener("abort", cancelPending)
      }
      if (decision !== "allow") {
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          ok: false,
          error: `Permission ${decision} for ${tool.kind} tool ${tool.name}`,
        }
      }
    }
    if (context.abortSignal.aborted) {
      return abortedExecution(toolCall)
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
        skillSources: this.options.skillSources,
        delegationDepth: context.delegationDepth ?? 0,
        runChildSession: this.options.runChildSession,
      }
      const startedAt = Date.now()
      const result = await tool.execute(finalToolCall.input, toolContext)
      const normalized = await normalizeResult(toolCall, result, this.options.maxOutputBytes, this.options.outputStore)
      await this.options.hooks?.afterTool({
        sessionId: context.sessionId,
        toolCall: finalToolCall,
        result: normalized,
        providerId: registered.providerId,
        provenance: registered.provenance,
        durationMs: Date.now() - startedAt,
        permissionDecision: "allow",
        abortSignal: context.abortSignal,
      })
      return normalized
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

function createPermissionRequest(
  capability: Capability,
  kind: ToolKind,
  toolCall: ToolCall,
  context: ToolBatchContext,
  requiresApproval: boolean,
): PermissionRequest {
  return {
    sessionId: context.sessionId,
    agentId: context.agentId,
    action: capability,
    resources: resourcesForInput(capability, kind, toolCall.input),
    requiresApproval,
    source: {
      type: "tool",
      toolCallId: toolCall.id,
      messageId: context.assistantMessageId,
    },
  }
}

function resourcesForInput(capability: Capability, kind: ToolKind, input: unknown): string[] {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>
    if (capability === "agent.delegate" || kind === "delegate") {
      const mode = typeof record.mode === "string" ? record.mode : "build"
      const provider = typeof record.provider === "string" ? record.provider : "default"
      const model = typeof record.model === "string" ? record.model : "default"
      const cwd = typeof record.cwd === "string" ? record.cwd : "current"
      return [`mode:${mode}/model:${provider}/${model}/cwd:${cwd}`]
    }
    if (typeof record.path === "string") return [record.path]
    if (typeof record.command === "string") {
      return capability === "process.execute" || kind === "execute"
        ? commandPermissionResources(record.command)
        : [record.command]
    }
    if (typeof record.pattern === "string") return [record.pattern]
    if (typeof record.url === "string") return [record.url]
  }

  return ["unknown"]
}

export function modeAllowsCapability(mode: AgentMode, capability: Capability): boolean {
  if (mode === "plan") {
    return capability === "filesystem.read" || capability === "user.interact" || capability === "session.update"
  }
  if (mode === "explore") return capability === "filesystem.read"
  if (mode === "orchestrate") {
    return capability === "filesystem.read" || capability === "agent.delegate"
  }
  return true
}

function modeDenialReason(
  mode: AgentMode,
  tool: NonNullable<ReturnType<ToolRegistry["get"]>>,
  _input: unknown,
): string | undefined {
  const capabilities = capabilitiesForDefinition(tool)
  const deniedCapability = capabilities.find((capability) => !modeAllowsCapability(mode, capability))
  if (deniedCapability) {
    return `${mode} mode denies capability ${deniedCapability} for tool ${tool.name}`
  }

  return undefined
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
