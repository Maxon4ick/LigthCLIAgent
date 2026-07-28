import path from "node:path"
import type { AppConfig, ModelRef } from "../config/schema.js"
import { materializeSystemContext, type SystemContext } from "../context/system-context.js"
import type { SkillSource } from "../context/skills.js"
import type { EventBus } from "../events/event-bus.js"
import type { HookPipeline } from "../hooks/hooks.js"
import type { LLMEvent, ProviderAdapter } from "../llm/provider.js"
import type { PermissionPolicy } from "../permissions/policy.js"
import type { ToolOutputStore } from "../tools/output-store.js"
import type { ToolRegistry } from "../tools/registry.js"
import { ToolScheduler, type ToolExecution } from "../tools/scheduler.js"
import type { Message, MessagePart, Session, TokenUsage, ToolCall } from "./message-types.js"
import type { SessionStore } from "./session-store.js"
import type { ContextBudgetManager } from "../context/context-budget.js"
import type { RunStop, RunStopReason } from "../run-stop.js"
import { redactSecrets } from "../security/redaction.js"

export type { RunStop, RunStopReason } from "../run-stop.js"

/** @deprecated Use RunStopReason. */
export type SessionStopReason = RunStopReason

export interface Tokenizer {
  estimateText(text: string): number
  estimateMessages(messages: readonly Message[]): number
}

export interface SessionRunnerOptions {
  store: SessionStore
  eventBus: EventBus
  provider: ProviderAdapter
  providerFactory?: (model: ModelRef) => ProviderAdapter
  toolRegistry: ToolRegistry
  permissionPolicy: PermissionPolicy
  config: AppConfig
  outputStore?: ToolOutputStore
  initialize?: Promise<void>
  skillSources?: readonly SkillSource[]
  hooks?: HookPipeline
  tokenizer?: Tokenizer
  contextBudget?: ContextBudgetManager
}

export interface SessionRunResult {
  sessionId: string
  assistantText: string
  toolResults: ToolExecution[]
  usage?: TokenUsage
  stop: RunStop
  /** @deprecated Use stop.reason. */
  stopReason: RunStopReason
  error?: string
}

export class SessionRunner {
  private currentProvider: ProviderAdapter
  private readonly tokenizer: Tokenizer

  constructor(private readonly options: SessionRunnerOptions) {
    this.currentProvider = options.provider
    this.tokenizer = options.tokenizer ?? approximateTokenizer
  }

  setProvider(provider: ProviderAdapter): void {
    this.currentProvider = provider
  }

  private providerFor(model: ModelRef): ProviderAdapter {
    return this.options.providerFactory?.(model) ?? this.currentProvider
  }

  async run(sessionId: string, abortSignal: AbortSignal = new AbortController().signal): Promise<SessionRunResult> {
    let session = this.options.store.updateStatus(sessionId, "running")
    let assistantText = ""
    let usage: TokenUsage | undefined
    let stop: RunStop = { reason: "iteration_limit", iteration: 0, retryable: false }
    let runError: string | undefined
    const allToolResults: ToolExecution[] = []

    this.options.eventBus.publish({ type: "session.status", payload: { sessionId, status: "running" } })

    try {
      await this.options.initialize
      for (let iteration = 0; iteration < this.options.config.agent.maxIterations; iteration += 1) {
        stop = { ...stop, iteration }
        if (abortSignal.aborted) {
          stop = { reason: "cancelled", iteration, retryable: false }
          break
        }

        session = this.options.store.getSession(sessionId)
        let systemContext = await materializeSystemContext(session, this.options.config, this.options.skillSources)
        const model = this.modelEntry(session.model)
        const tools = model?.capabilities.tools === false ? [] : this.options.toolRegistry.list()
        let messages = this.options.store.listMessages(sessionId)
        try {
          messages = await this.options.hooks?.beforePrompt({
            sessionId,
            messages,
            systemContext,
            abortSignal,
          }) ?? messages
          if (Buffer.byteLength(JSON.stringify(messages), "utf8") > 1_000_000) {
            throw new Error("Prompt hook output exceeds the 1000000-byte limit")
          }
        } catch (error) {
          stop = {
            reason: "hook_rejected",
            message: redactSecrets(errorMessage(error)),
            iteration,
            retryable: false,
            errorCode: "HOOK_REJECTED",
          }
          runError = stop.message
          break
        }
        const budget = await this.prepareContextBudget(session, systemContext, messages, tools)
        if (budget?.status === "context_limit") {
          stop = {
            reason: "context_limit",
            message: "Required context exceeds the configured model context window",
            iteration,
            retryable: false,
            errorCode: "CONTEXT_LIMIT",
          }
          runError = stop.message
          break
        }
        if (budget?.status === "compacted") {
          this.options.store.compactSession(sessionId, {
            summary: budget.summary ?? session.summary ?? "Earlier context was compacted.",
            keepLastMessages: budget.keepLastMessages,
          })
          session = this.options.store.getSession(sessionId)
          systemContext = await materializeSystemContext(session, this.options.config, this.options.skillSources)
          messages = this.options.store.listMessages(sessionId)
        }
        const streamed = await this.streamWithFallback(session, systemContext, messages, tools, abortSignal)
        if (!streamed.ok) {
          stop = abortSignal.aborted
            ? { reason: "cancelled", iteration, retryable: false }
            : {
                reason: "provider_error",
                message: redactSecrets(streamed.error),
                iteration,
                retryable: streamed.retryable,
                errorCode: "PROVIDER_ERROR",
              }
          runError = stop.message
          break
        }
        if (abortSignal.aborted) {
          stop = { reason: "cancelled", iteration, retryable: false }
          break
        }

        assistantText = streamed.text
        usage = addUsage(usage, streamed.usage)
        const assistantParts: MessagePart[] = streamed.toolCalls.map((toolCall) => ({
          type: "tool_call",
          toolCallId: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        }))
        if (streamed.text.length > 0) assistantParts.unshift({ type: "text", text: streamed.text })

        const assistantMessage = this.options.store.addMessage({
          sessionId,
          role: "assistant",
          parts: assistantParts.length > 0 ? assistantParts : [{ type: "text", text: "" }],
          usage: streamed.usage,
        })
        this.options.eventBus.publish({ type: "message.created", payload: { sessionId, message: assistantMessage } })
        if (streamed.usage) {
          this.options.eventBus.publish({
            type: "llm.usage",
            payload: { sessionId, messageId: assistantMessage.id, usage: streamed.usage },
          })
        }
        for (const toolCall of streamed.toolCalls) {
          this.options.eventBus.publish({
            type: "tool.call",
            payload: { sessionId, messageId: assistantMessage.id, toolCall },
          })
        }

        if (streamed.toolCalls.length === 0) {
          stop = { reason: "completed", iteration, retryable: false }
          break
        }

        const scheduler = new ToolScheduler({
          registry: this.options.toolRegistry,
          permissionPolicy: this.options.permissionPolicy,
          eventBus: this.options.eventBus,
          sessionStore: this.options.store,
          config: this.options.config,
          maxOutputBytes: this.options.config.toolOutput.maxBytes,
          maxCaptureBytes: Math.max(this.options.config.toolOutput.maxBytes, this.options.config.toolOutput.maxStoredBytes),
          auditLogPath: resolveRuntimePath(session.cwd, this.options.config.audit.path),
          outputStore: this.options.outputStore,
          hooks: this.options.hooks,
          skillSources: this.options.skillSources,
          runChildSession: async (childSessionId, signal) => {
            const result = await this.run(childSessionId, signal)
            return {
              assistantText: result.assistantText,
              ok: result.stop.reason === "completed",
              error: result.error ?? (result.stop.reason === "completed" ? undefined : result.stop.reason),
            }
          },
        })

        const executed = await scheduler.executeBatch(streamed.toolCalls, {
          sessionId,
          assistantMessageId: assistantMessage.id,
          agentId: session.agentId,
          agentMode: session.mode,
          cwd: session.cwd,
          abortSignal,
          delegationDepth: delegationDepth(session, this.options.store),
        })
        const iterResults = completeToolResults(streamed.toolCalls, executed, abortSignal.aborted)
        allToolResults.push(...iterResults)
        if (iterResults.some((result) => result.errorCode === "hook_rejected")) {
          stop = {
            reason: "hook_rejected",
            message: "A beforeTool hook rejected the tool call",
            iteration,
            retryable: false,
            errorCode: "HOOK_REJECTED",
          }
          runError = stop.message
        }

        // Store a result for every assistant tool call, including calls skipped by abort.
        for (const result of iterResults) {
          const toolMessage = this.options.store.addMessage({
            sessionId,
            role: "tool",
            parts: [{
              type: "tool_result",
              toolCallId: result.toolCallId,
              name: result.name,
              output: result.output,
              error: result.error,
            }],
          })
          this.options.eventBus.publish({ type: "message.created", payload: { sessionId, message: toolMessage } })
        }

        if (abortSignal.aborted) {
          stop = { reason: "cancelled", iteration, retryable: false }
          break
        }
        if (stop.reason === "hook_rejected") break
      }
    } catch (error) {
      stop = abortSignal.aborted
        ? { reason: "cancelled", iteration: stop.iteration, retryable: false }
        : {
            reason: "error",
            message: redactSecrets(errorMessage(error)),
            iteration: stop.iteration,
            retryable: false,
            errorCode: "RUNTIME_ERROR",
          }
      runError = stop.message
    }

    if (stop.reason === "iteration_limit" && !runError) {
      runError = `Agent reached the configured iteration limit (${this.options.config.agent.maxIterations})`
      stop = {
        ...stop,
        message: runError,
        iteration: this.options.config.agent.maxIterations,
        errorCode: "ITERATION_LIMIT",
      }
    }
    const status = stop.reason === "cancelled" ? "cancelled"
      : stop.reason === "completed" ? "idle"
      : "error"
    this.options.store.updateStatus(sessionId, status)
    if (runError) this.options.eventBus.publish({ type: "session.error", payload: { sessionId, error: runError } })
    if (status === "idle") this.options.eventBus.publish({ type: "session.idle", payload: { sessionId } })
    this.options.eventBus.publish({ type: "session.status", payload: { sessionId, status } })
    await this.options.hooks?.onStop({ sessionId, stop, abortSignal })
    this.options.eventBus.publish({
      type: "session.run.stopped",
      payload: {
        sessionId,
        reason: stop.reason,
        iteration: stop.iteration,
        retryable: stop.retryable,
        errorCode: stop.errorCode,
      },
    })

    return {
      sessionId,
      assistantText,
      toolResults: allToolResults,
      usage,
      stop,
      stopReason: stop.reason === "provider_error" ? "error" : stop.reason,
      error: runError,
    }
  }

  private async streamWithFallback(
    session: Session,
    systemContext: SystemContext,
    messages: Message[],
    tools: ReturnType<ToolRegistry["list"]>,
    abortSignal: AbortSignal,
  ): Promise<StreamResult> {
    try {
      return await collectStream(this.providerFor(session.model), session, systemContext, messages, tools, abortSignal, this.options.eventBus)
    } catch (error) {
      const fallback = this.options.config.models.fallback
      if (
        abortSignal.aborted ||
        !fallback ||
        sameModel(fallback, session.model) ||
        !isFallbackEligible(error)
      ) {
        return { ok: false, error: errorMessage(error), retryable: isFallbackEligible(error) }
      }
      try {
        return await collectStream(
          this.providerFor(fallback),
          { ...session, model: fallback },
          systemContext,
          messages,
          tools,
          abortSignal,
          this.options.eventBus,
        )
      } catch (fallbackError) {
        return {
          ok: false,
          error: `Primary provider failed: ${errorMessage(error)}; fallback failed: ${errorMessage(fallbackError)}`,
          retryable: isFallbackEligible(fallbackError),
        }
      }
    }
  }

  private async prepareContextBudget(
    session: Session,
    systemContext: SystemContext,
    messages: Message[],
    tools: ReturnType<ToolRegistry["list"]>,
  ) {
    if (!this.options.config.agent.contextBudget.enabled || !this.options.contextBudget) return undefined
    const model = this.modelEntry(session.model)
    const maxTokens = model?.capabilities.maxContextTokens
    if (!maxTokens) return undefined
    return this.options.contextBudget.prepare({
      sessionId: session.id,
      systemContext: systemContext.text,
      summary: session.summary,
      messages,
      tools,
      maxContextTokens: maxTokens,
      reserveOutputTokens: model.capabilities.maxOutputTokens ??
        this.options.config.agent.contextBudget.reserveOutputTokens,
      compactionThreshold: this.options.config.agent.contextBudget.compactionThreshold,
    })
  }

  private modelEntry(model: ModelRef) {
    return this.options.config.models.catalog.find(
      (entry) => entry.provider === model.provider && entry.model === model.model,
    )
  }
}

interface SuccessfulStream {
  ok: true
  text: string
  toolCalls: ToolCall[]
  usage?: TokenUsage
}

interface FailedStream {
  ok: false
  error: string
  retryable: boolean
}

type StreamResult = SuccessfulStream | FailedStream

async function collectStream(
  provider: ProviderAdapter,
  session: Session,
  systemContext: SystemContext,
  messages: Message[],
  tools: ReturnType<ToolRegistry["list"]>,
  abortSignal: AbortSignal,
  events: EventBus,
): Promise<SuccessfulStream> {
  let text = ""
  let usage: TokenUsage | undefined
  const toolCalls: ToolCall[] = []
  for await (const event of provider.stream({ session, systemContext, messages, tools, abortSignal })) {
    if (abortSignal.aborted) break
    consumeEvent(event)
  }
  return { ok: true, text, toolCalls, usage }

  function consumeEvent(event: LLMEvent): void {
    if (event.type === "text_delta") {
      text += event.text
      events.publish({ type: "llm.text_delta", payload: { sessionId: session.id, messageId: "pending", text: event.text } })
    } else if (event.type === "usage") {
      usage = event.usage
    } else if (event.type === "tool_call") {
      toolCalls.push(event.toolCall)
    } else if (event.type === "error") {
      throw new ProviderStreamError(event.error)
    }
  }
}

class ProviderStreamError extends Error {}

const approximateTokenizer: Tokenizer = {
  estimateText: (text) => Math.ceil(text.length / 4),
  estimateMessages: (messages) => Math.ceil(JSON.stringify(messages).length / 4),
}

function completeToolResults(calls: ToolCall[], results: ToolExecution[], aborted: boolean): ToolExecution[] {
  const byId = new Map(results.map((result) => [result.toolCallId, result]))
  return calls.map((call) => byId.get(call.id) ?? {
    toolCallId: call.id,
    name: call.name,
    ok: false,
    error: aborted ? "Tool execution aborted" : "Tool execution did not produce a result",
  })
}

function delegationDepth(session: Session, store: SessionStore): number {
  const explicit = session.metadata?.delegationDepth
  if (typeof explicit === "number" && Number.isInteger(explicit) && explicit >= 0) return explicit
  let depth = 0
  let current = session
  const visited = new Set<string>([session.id])
  while (current.parentSessionId) {
    if (visited.has(current.parentSessionId)) return Number.MAX_SAFE_INTEGER
    visited.add(current.parentSessionId)
    depth += 1
    current = store.getSession(current.parentSessionId)
  }
  return depth
}

function safeToolPairKeepCount(messages: Message[], desired: number): number {
  let start = Math.max(0, messages.length - desired)
  if (messages[start]?.role === "tool") {
    const resultIds = new Set(messages.slice(start).flatMap((message) =>
      message.parts.filter((part) => part.type === "tool_result").map((part) => part.toolCallId),
    ))
    for (let index = start - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== "assistant") continue
      if (message.parts.some((part) => part.type === "tool_call" && resultIds.has(part.toolCallId))) {
        start = index
        break
      }
    }
  }
  return messages.length - start
}

function summarizeMessages(messages: Message[]): string {
  const lines = messages.flatMap((message) => {
    const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim()
    return text ? [`${message.role}: ${text}`] : []
  })
  return (lines.length > 0 ? lines.join("\n") : "Earlier tool interaction was compacted.").slice(0, 8_000)
}

function addUsage(total: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!next) return total
  return {
    inputTokens: (total?.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (total?.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (total?.totalTokens ?? 0) + (next.totalTokens ?? 0),
  }
}

function isFallbackEligible(error: unknown): boolean {
  if (error instanceof ProviderStreamError) return false
  const message = errorMessage(error)
  const status = /\((\d{3})\)/.exec(message)?.[1]
  if (status) {
    const code = Number(status)
    return code === 408 || code === 409 || code === 425 || code === 429 || code >= 500
  }
  return error instanceof TypeError || /ECONN|ETIMEDOUT|fetch failed|network/i.test(message)
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.model === right.model
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveRuntimePath(cwd: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(cwd, configuredPath)
}
