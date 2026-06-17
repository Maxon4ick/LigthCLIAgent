import type { SystemContext } from "../context/system-context.js"
import type { Message, Session, TokenUsage, ToolCall } from "../session/message-types.js"
import type { PublicToolDefinition } from "../tools/tool.js"

export interface ProviderAdapter {
  id: string
  stream(input: ProviderRequest): AsyncIterable<LLMEvent>
}

export interface ProviderRequest {
  session: Session
  systemContext: SystemContext
  messages: Message[]
  tools: PublicToolDefinition[]
  abortSignal?: AbortSignal
}

export type LLMEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done" }
  | { type: "error"; error: string }
