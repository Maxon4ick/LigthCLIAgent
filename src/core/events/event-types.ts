import type { Message, Session, SessionStatus, TokenUsage, ToolCall } from "../session/message-types.js"
import type { ToolExecution } from "../tools/scheduler.js"
import type { PendingApproval } from "../permissions/approvals.js"

export type EventType =
  | "session.created"
  | "session.updated"
  | "session.status"
  | "session.run.started"
  | "session.run.finished"
  | "session.run.aborted"
  | "message.created"
  | "llm.text_delta"
  | "llm.usage"
  | "tool.call"
  | "tool.result"
  | "permission.requested"
  | "permission.resolved"
  | "agent.question"
  | "session.error"
  | "session.idle"
  | "runtime.hook.error"
  | "runtime.extension.loaded"
  | "runtime.extension.failed"
  | "tool.provider.loaded"
  | "skill.source.loaded"
  | "hook.started"
  | "hook.finished"
  | "hook.failed"
  | "context.compacted"
  | "session.run.stopped"

export type AppEvent =
  | BaseEvent<"session.created", { session: Session }>
  | BaseEvent<"session.updated", { sessionId: string; session: Session }>
  | BaseEvent<"session.status", { sessionId: string; status: SessionStatus }>
  | BaseEvent<"session.run.started", { sessionId: string; runId: string }>
  | BaseEvent<"session.run.finished", {
      sessionId: string
      runId: string
      status: "completed" | "cancelled" | "error"
      stopReason: "completed" | "cancelled" | "iteration_limit" | "context_limit" | "provider_error" | "hook_rejected" | "error"
      durationMs: number
    }>
  | BaseEvent<"session.run.aborted", { sessionId: string; runId: string; reason?: string }>
  | BaseEvent<"message.created", { sessionId: string; message: Message }>
  | BaseEvent<"llm.text_delta", { sessionId: string; messageId: string; text: string }>
  | BaseEvent<"llm.usage", { sessionId: string; messageId: string; usage: TokenUsage }>
  | BaseEvent<"tool.call", { sessionId: string; messageId: string; toolCall: ToolCall }>
  | BaseEvent<"tool.result", { sessionId: string; messageId: string; result: ToolExecution }>
  | BaseEvent<"permission.requested", { sessionId: string; approval: PendingApproval }>
  | BaseEvent<"permission.resolved", { sessionId: string; approval: PendingApproval }>
  | BaseEvent<"agent.question", { sessionId: string; toolCallId: string; question: string; context?: string }>
  | BaseEvent<"session.error", { sessionId: string; error: string }>
  | BaseEvent<"session.idle", { sessionId: string }>
  | BaseEvent<"runtime.hook.error", {
      sessionId: string
      hookId: string
      provenance: string
      stage: string
      error: string
    }>
  | BaseEvent<"runtime.extension.loaded" | "runtime.extension.failed", ExtensionEventPayload>
  | BaseEvent<"tool.provider.loaded", ExtensionEventPayload>
  | BaseEvent<"skill.source.loaded", ExtensionEventPayload>
  | BaseEvent<"hook.started" | "hook.finished" | "hook.failed", HookEventPayload>
  | BaseEvent<"context.compacted", ContextCompactedPayload>
  | BaseEvent<"session.run.stopped", RunStoppedPayload>

export type AppEventDraft = Omit<AppEvent, "id" | "sequence" | "version" | "createdAt">

interface BaseEvent<TType extends EventType, TPayload extends object> {
  id: number
  sequence: number
  version: 1
  type: TType
  createdAt: string
  payload: TPayload
}

interface ExtensionEventPayload {
  runtimeId?: string
  extensionId: string
  provenance: string
  durationMs?: number
  error?: string
}

interface HookEventPayload {
  sessionId?: string
  runId?: string
  hookId: string
  provenance: string
  stage: string
  durationMs?: number
  error?: string
}

interface ContextCompactedPayload {
  sessionId: string
  tokensBefore: number
  tokensAfter: number
  removedMessages: number
  retainedMessages: number
  estimatorId: string
}

interface RunStoppedPayload {
  sessionId: string
  runId?: string
  reason: string
  iteration: number
  retryable?: boolean
  errorCode?: string
}
