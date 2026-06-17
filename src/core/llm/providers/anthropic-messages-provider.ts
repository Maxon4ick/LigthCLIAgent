import { createId } from "../../../shared/ids.js"
import { redactSecrets } from "../../security/redaction.js"
import type { Message, MessagePart, TokenUsage, ToolCall } from "../../session/message-types.js"
import type { PublicToolDefinition } from "../../tools/tool.js"
import { sanitizeProviderRequest } from "../model-request-sanitizer.js"
import { fetchWithProviderPolicy } from "../fetch-policy.js"
import type { LLMEvent, ProviderAdapter, ProviderRequest } from "../provider.js"

interface ApiConnection {
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | Array<Record<string, unknown>>
}

interface PendingToolUse {
  id: string
  name: string
  argumentsText: string
}

export class AnthropicMessagesProvider implements ProviderAdapter {
  readonly id = "anthropic"

  constructor(private readonly connection: ApiConnection) {}

  async *stream(input: ProviderRequest): AsyncIterable<LLMEvent> {
    const sanitized = sanitizeProviderRequest(input)
    const response = await fetchWithProviderPolicy(`${trimTrailingSlash(this.connection.baseUrl)}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.connection.apiKey,
        "anthropic-version": "2023-06-01",
        ...this.connection.headers,
      },
      body: JSON.stringify({
        max_tokens: 4096,
        stream: true,
        ...this.connection.body,
        model: input.session.model.model,
        system: sanitized.systemContext.text,
        messages: sanitized.messages.flatMap(toAnthropicMessages),
        tools: sanitized.tools.map(toAnthropicTool),
      }),
      signal: input.abortSignal,
    })

    if (!response.ok) {
      const body = redactSecrets(await response.text())
      throw new Error(`Anthropic request failed (${response.status}): ${body}`)
    }

    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text/event-stream")) {
      yield* parseNonStreamingResponse(await response.json())
      return
    }

    const pendingToolUses = new Map<number, PendingToolUse>()
    const decoder = new TextDecoder()
    let buffer = ""

    for await (const chunk of readResponseBody(response)) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const data = parseSseLine(line)
        if (!data) continue
        const parsed = safeJson(data)
        if (!parsed) continue

        for (const event of parseStreamingEvent(parsed, pendingToolUses)) {
          yield event
        }
      }
    }

    yield* flushToolUses(pendingToolUses)
    yield { type: "done" }
  }
}

function toAnthropicMessages(message: Message): AnthropicMessage[] {
  if (message.role === "system") {
    return []
  }

  if (message.role === "tool") {
    const content = message.parts
      .filter((part) => part.type === "tool_result")
      .map((part) => ({
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: JSON.stringify({ output: part.output, error: part.error }),
        is_error: Boolean(part.error),
      }))
    return [{ role: "user", content }]
  }

  const toolCalls = message.parts.filter((part) => part.type === "tool_call")
  if (message.role === "assistant" && toolCalls.length > 0) {
    const content: Array<Record<string, unknown>> = []
    const text = textParts(message.parts)
    if (text) {
      content.push({ type: "text", text })
    }
    for (const part of toolCalls) {
      content.push({
        type: "tool_use",
        id: part.toolCallId,
        name: part.name,
        input: part.input ?? {},
      })
    }
    return [{ role: "assistant", content }]
  }

  return [
    {
      role: message.role === "assistant" ? "assistant" : "user",
      content: textParts(message.parts),
    },
  ]
}

function textParts(parts: MessagePart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function toAnthropicTool(tool: PublicToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

function* parseStreamingEvent(
  value: unknown,
  pendingToolUses: Map<number, PendingToolUse>,
): Iterable<LLMEvent> {
  if (!isRecord(value) || typeof value.type !== "string") return

  if (value.type === "content_block_start" && isRecord(value.content_block)) {
    const index = typeof value.index === "number" ? value.index : pendingToolUses.size
    if (value.content_block.type === "tool_use" && typeof value.content_block.name === "string") {
      pendingToolUses.set(index, {
        id: typeof value.content_block.id === "string" ? value.content_block.id : createId("tool"),
        name: value.content_block.name,
        argumentsText: "",
      })
    }
    return
  }

  if (value.type === "content_block_delta" && isRecord(value.delta)) {
    if (value.delta.type === "text_delta" && typeof value.delta.text === "string") {
      yield { type: "text_delta", text: value.delta.text }
      return
    }
    if (value.delta.type === "input_json_delta" && typeof value.delta.partial_json === "string") {
      const index = typeof value.index === "number" ? value.index : pendingToolUses.size - 1
      const pending = pendingToolUses.get(index)
      if (pending) {
        pending.argumentsText += value.delta.partial_json
      }
      return
    }
  }

  if (value.type === "message_delta") {
    const usage = parseUsage(isRecord(value.usage) ? value.usage : isRecord(value.delta) ? value.delta.usage : undefined)
    if (usage) {
      yield { type: "usage", usage }
    }
    return
  }

  if (value.type === "message_stop") {
    yield* flushToolUses(pendingToolUses)
    yield { type: "done" }
  }
}

function* parseNonStreamingResponse(value: unknown): Iterable<LLMEvent> {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    yield { type: "error", error: "Anthropic response did not contain content" }
    return
  }

  for (const item of value.content) {
    if (!isRecord(item)) continue
    if (item.type === "text" && typeof item.text === "string") {
      yield { type: "text_delta", text: item.text }
    }
    if (item.type === "tool_use" && typeof item.name === "string") {
      yield {
        type: "tool_call",
        toolCall: {
          id: typeof item.id === "string" ? item.id : createId("tool"),
          name: item.name,
          input: isRecord(item.input) ? item.input : {},
        },
      }
    }
  }

  const usage = parseUsage(value.usage)
  if (usage) {
    yield { type: "usage", usage }
  }
  yield { type: "done" }
}

function* flushToolUses(pendingToolUses: Map<number, PendingToolUse>): Iterable<LLMEvent> {
  const ordered = [...pendingToolUses.entries()].sort(([left], [right]) => left - right)
  pendingToolUses.clear()
  for (const [, pending] of ordered) {
    yield {
      type: "tool_call",
      toolCall: {
        id: pending.id,
        name: pending.name,
        input: parseToolArguments(pending.argumentsText),
      },
    }
  }
}

function parseToolArguments(value: string): unknown {
  if (!value.trim()) {
    return {}
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    return { raw: value }
  }
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = readUsageNumber(value.input_tokens) ?? 0
  const output = readUsageNumber(value.output_tokens) ?? 0
  if (input === 0 && output === 0) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
  }
}

function readUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

async function* readResponseBody(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) return
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

function parseSseLine(line: string): string | undefined {
  return line.startsWith("data:") ? line.slice("data:".length).trim() : undefined
}

function safeJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
