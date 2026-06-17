import path from "node:path"
import type { AppConfig } from "../config/schema.js"
import { materializeSystemContext } from "../context/system-context.js"
import type { EventBus } from "../events/event-bus.js"
import type { ProviderAdapter } from "../llm/provider.js"
import type { PermissionPolicy } from "../permissions/policy.js"
import type { ToolOutputStore } from "../tools/output-store.js"
import type { ToolRegistry } from "../tools/registry.js"
import { ToolScheduler, type ToolExecution } from "../tools/scheduler.js"
import type { MessagePart, TokenUsage, ToolCall } from "./message-types.js"
import type { SessionStore } from "./session-store.js"

const MAX_ITERATIONS = 10

export interface SessionRunnerOptions {
  store: SessionStore
  eventBus: EventBus
  provider: ProviderAdapter
  toolRegistry: ToolRegistry
  permissionPolicy: PermissionPolicy
  config: AppConfig
  outputStore?: ToolOutputStore
}

export interface SessionRunResult {
  sessionId: string
  assistantText: string
  toolResults: ToolExecution[]
  usage?: TokenUsage
}

export class SessionRunner {
  private currentProvider: ProviderAdapter

  constructor(private readonly options: SessionRunnerOptions) {
    this.currentProvider = options.provider
  }

  setProvider(provider: ProviderAdapter): void {
    this.currentProvider = provider
  }

  async run(sessionId: string, abortSignal: AbortSignal = new AbortController().signal): Promise<SessionRunResult> {
    const session = this.options.store.updateStatus(sessionId, "running")
    let assistantText = ""
    let usage: TokenUsage | undefined
    const allToolResults: ToolExecution[] = []

    this.options.eventBus.publish({
      type: "session.status",
      payload: { sessionId, status: "running" },
    })

    try {
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        if (abortSignal.aborted) break

        const systemContext = await materializeSystemContext(session, this.options.config)
        const messages = this.options.store.listMessages(sessionId)
        const model = this.options.config.models.catalog.find(
          (entry) => entry.provider === session.model.provider && entry.model === session.model.model,
        )
        const tools = model?.capabilities.tools === false ? [] : this.options.toolRegistry.list()
        const assistantParts: MessagePart[] = []
        const toolCalls: ToolCall[] = []
        let iterText = ""
        let iterUsage: TokenUsage | undefined

        for await (const event of this.currentProvider.stream({ session, systemContext, messages, tools, abortSignal })) {
          if (abortSignal.aborted) break

          if (event.type === "text_delta") {
            iterText += event.text
            this.options.eventBus.publish({
              type: "llm.text_delta",
              payload: { sessionId, messageId: "pending", text: event.text },
            })
            continue
          }

          if (event.type === "usage") {
            iterUsage = event.usage
            continue
          }

          if (event.type === "tool_call") {
            toolCalls.push(event.toolCall)
            assistantParts.push({
              type: "tool_call",
              toolCallId: event.toolCall.id,
              name: event.toolCall.name,
              input: event.toolCall.input,
            })
            continue
          }

          if (event.type === "error") {
            throw new Error(event.error)
          }

          if (event.type === "done") {
            break
          }
        }

        if (abortSignal.aborted) break

        assistantText = iterText
        if (iterUsage) {
          usage = usage
            ? {
                inputTokens: (usage.inputTokens ?? 0) + (iterUsage.inputTokens ?? 0),
                outputTokens: (usage.outputTokens ?? 0) + (iterUsage.outputTokens ?? 0),
                totalTokens: (usage.totalTokens ?? 0) + (iterUsage.totalTokens ?? 0),
              }
            : iterUsage
        }

        if (iterText.length > 0) {
          assistantParts.unshift({ type: "text", text: iterText })
        }

        const assistantMessage = this.options.store.addMessage({
          sessionId,
          role: "assistant",
          parts: assistantParts.length > 0 ? assistantParts : [{ type: "text", text: "" }],
          usage: iterUsage,
        })

        this.options.eventBus.publish({
          type: "message.created",
          payload: { sessionId, message: assistantMessage },
        })

        if (iterUsage) {
          this.options.eventBus.publish({
            type: "llm.usage",
            payload: { sessionId, messageId: assistantMessage.id, usage: iterUsage },
          })
        }

        for (const toolCall of toolCalls) {
          this.options.eventBus.publish({
            type: "tool.call",
            payload: { sessionId, messageId: assistantMessage.id, toolCall },
          })
        }

        if (toolCalls.length === 0) break

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
          runChildSession: async (childSessionId, signal) => {
            try {
              const result = await this.run(childSessionId, signal)
              return { assistantText: result.assistantText, ok: true }
            } catch (error) {
              return {
                assistantText: "",
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }
          },
        })

        const iterResults = await scheduler.executeBatch(toolCalls, {
          sessionId,
          assistantMessageId: assistantMessage.id,
          agentId: session.agentId,
          agentMode: session.mode,
          cwd: session.cwd,
          abortSignal,
        })

        for (const result of iterResults) {
          allToolResults.push(result)
        }

        if (abortSignal.aborted) break

        for (const result of iterResults) {
          const toolMessage = this.options.store.addMessage({
            sessionId,
            role: "tool",
            parts: [
              {
                type: "tool_result",
                toolCallId: result.toolCallId,
                name: result.name,
                output: result.output,
                error: result.error,
              },
            ],
          })
          this.options.eventBus.publish({
            type: "message.created",
            payload: { sessionId, message: toolMessage },
          })
        }
      }

      if (abortSignal.aborted) {
        this.options.store.updateStatus(sessionId, "cancelled")
        this.options.eventBus.publish({
          type: "session.status",
          payload: { sessionId, status: "cancelled" },
        })
        return { sessionId, assistantText, toolResults: allToolResults, usage }
      }

      this.options.store.updateStatus(sessionId, "idle")
      this.options.eventBus.publish({ type: "session.idle", payload: { sessionId } })
      this.options.eventBus.publish({ type: "session.status", payload: { sessionId, status: "idle" } })

      return { sessionId, assistantText, toolResults: allToolResults, usage }
    } catch (error) {
      if (abortSignal.aborted) {
        this.options.store.updateStatus(sessionId, "cancelled")
        this.options.eventBus.publish({
          type: "session.status",
          payload: { sessionId, status: "cancelled" },
        })
        return { sessionId, assistantText, toolResults: allToolResults, usage }
      }

      const message = error instanceof Error ? error.message : String(error)
      this.options.store.updateStatus(sessionId, "error")
      this.options.eventBus.publish({ type: "session.error", payload: { sessionId, error: message } })
      this.options.eventBus.publish({ type: "session.status", payload: { sessionId, status: "error" } })
      throw error
    }
  }
}

function resolveRuntimePath(cwd: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(cwd, configuredPath)
}
