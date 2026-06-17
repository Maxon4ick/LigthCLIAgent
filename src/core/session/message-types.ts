import type { AgentMode, ModelRef } from "../config/schema.js"

export type SessionStatus = "idle" | "running" | "cancelled" | "error"

export interface TodoItem {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed"
}

export interface Session {
  id: string
  cwd: string
  status: SessionStatus
  model: ModelRef
  agentId: string
  mode: AgentMode
  title?: string
  summary?: string
  parentSessionId?: string
  todos?: TodoItem[]
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface Message {
  id: string
  sessionId: string
  role: "system" | "user" | "assistant" | "tool"
  parts: MessagePart[]
  createdAt: string
  usage?: TokenUsage
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCallId: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; name: string; output: unknown; error?: string }

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}
