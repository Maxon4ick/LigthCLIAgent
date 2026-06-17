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

export type AppEvent =
  | BaseEvent<"session.created", { session: Session }>
  | BaseEvent<"session.updated", { sessionId: string; session: Session }>
  | BaseEvent<"session.status", { sessionId: string; status: SessionStatus }>
  | BaseEvent<"session.run.started", { sessionId: string; runId: string }>
  | BaseEvent<"session.run.finished", { sessionId: string; runId: string; status: "completed" | "cancelled" | "error"; durationMs: number }>
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

export type AppEventDraft = Omit<AppEvent, "id" | "sequence" | "version" | "createdAt">

interface BaseEvent<TType extends EventType, TPayload extends Record<string, unknown>> {
  id: number
  sequence: number
  version: 1
  type: TType
  createdAt: string
  payload: TPayload
}
