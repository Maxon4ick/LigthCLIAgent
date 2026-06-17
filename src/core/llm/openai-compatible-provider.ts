import { createId } from "../../shared/ids.js"
import type { AppConfig } from "../config/schema.js"
import { redactSecrets } from "../security/redaction.js"
import type { Message, MessagePart, TokenUsage, ToolCall } from "../session/message-types.js"
import type { PublicToolDefinition } from "../tools/tool.js"
import { sanitizeProviderRequest } from "./model-request-sanitizer.js"
import { fetchWithProviderPolicy } from "./fetch-policy.js"
import type { LLMEvent, ProviderAdapter, ProviderRequest } from "./provider.js"

export interface OpenAICompatibleProviderOptions {
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: "function"
    function: {
      name: string
      arguments: string
    }
  }>
}

interface PendingToolCall {
  id?: string
  name?: string
  argumentsText: string
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly id = "openai-compatible"

  constructor(private readonly options: OpenAICompatibleProviderOptions) {}

  async *stream(input: ProviderRequest): AsyncIterable<LLMEvent> {
    const sanitizedInput = sanitizeProviderRequest(input)
    const url = resolveChatCompletionsUrl(this.options.baseUrl)
    const openAITools = sanitizedInput.tools.map(toOpenAITool)
    const response = await fetchWithProviderPolicy(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
        ...this.options.headers,
      },
      body: JSON.stringify({
        ...this.options.body,
        model: input.session.model.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: toChatMessages(sanitizedInput),
        ...(openAITools.length > 0 ? { tools: openAITools } : {}),
      }),
      signal: input.abortSignal,
    })

    if (!response.ok) {
      const body = redactSecrets(await response.text())
      throw new Error(`OpenAI-compatible request failed (${response.status}) POST ${url} model=${input.session.model.model}: ${body}`)
    }

    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text/event-stream")) {
      yield* parseNonStreamingResponse(await response.json())
      return
    }

    const pendingToolCalls = new Map<number, PendingToolCall>()
    const decoder = new TextDecoder()
    let buffer = ""

    for await (const chunk of readResponseBody(response)) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const event = parseSseLine(line)
        if (!event) continue

        if (event === "[DONE]") {
          yield* flushToolCalls(pendingToolCalls)
          yield { type: "done" }
          return
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(event) as unknown
        } catch {
          yield { type: "error", error: "OpenAI-compatible stream returned invalid JSON" }
          continue
        }
        for (const llmEvent of parseStreamingChunk(parsed, pendingToolCalls)) {
          yield llmEvent
        }
      }
    }

    yield* flushToolCalls(pendingToolCalls)
    yield { type: "done" }
  }
}

export function createOpenAICompatibleProvider(config: AppConfig): OpenAICompatibleProvider {
  const providerConfig = config.providers.openaiCompatible
  const apiKey =
    providerConfig.apiKey ??
    process.env[providerConfig.apiKeyEnv] ??
    process.env.OPENAI_COMPATIBLE_API_KEY ??
    process.env.OPENAI_API_KEY

  if (!apiKey) {
    throw new Error(
      `Missing API key for openai-compatible provider. Set ${providerConfig.apiKeyEnv}, OPENAI_COMPATIBLE_API_KEY, or pass --api-key.`,
    )
  }

  return new OpenAICompatibleProvider({
    baseUrl: providerConfig.baseUrl,
    apiKey,
  })
}

function toChatMessages(input: ProviderRequest): ChatMessage[] {
  return [
    {
      role: "system",
      content: input.systemContext.text,
    },
    ...input.messages.flatMap(toChatMessage),
  ]
}

function toChatMessage(message: Message): ChatMessage[] {
  if (message.role === "tool") {
    return message.parts
      .filter((part) => part.type === "tool_result")
      .map((part) => ({
        role: "tool" as const,
        tool_call_id: part.toolCallId,
        content: JSON.stringify({ output: part.output, error: part.error }),
      }))
  }

  const text = textParts(message.parts)
  const toolCalls = message.parts.filter((part) => part.type === "tool_call")

  if (message.role === "assistant" && toolCalls.length > 0) {
    return [
      {
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((part) => ({
          id: part.toolCallId,
          type: "function",
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        })),
      },
    ]
  }

  return [
    {
      role: message.role === "system" ? "system" : message.role === "assistant" ? "assistant" : "user",
      content: text,
    },
  ]
}

function textParts(parts: MessagePart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function toOpenAITool(tool: PublicToolDefinition): unknown {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

async function* readResponseBody(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) {
    return
  }

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
  if (!line.startsWith("data:")) {
    return undefined
  }

  return line.slice("data:".length).trim()
}

function* parseStreamingChunk(value: unknown, pendingToolCalls: Map<number, PendingToolCall>): Iterable<LLMEvent> {
  if (!isRecord(value)) {
    return
  }

  const usage = parseUsage(value.usage)
  if (usage) {
    yield { type: "usage", usage }
  }

  const choices = value.choices
  if (!Array.isArray(choices)) {
    return
  }

  for (const choice of choices) {
    if (!isRecord(choice)) continue
    const delta = isRecord(choice.delta) ? choice.delta : {}
    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text_delta", text: delta.content }
    }

    const toolCalls = delta.tool_calls
    if (Array.isArray(toolCalls)) {
      for (const chunk of toolCalls) {
        mergeToolCallChunk(pendingToolCalls, chunk)
      }
    }
  }
}

function mergeToolCallChunk(pendingToolCalls: Map<number, PendingToolCall>, chunk: unknown): void {
  if (!isRecord(chunk)) return

  const index = typeof chunk.index === "number" ? chunk.index : 0
  const current = pendingToolCalls.get(index) ?? { argumentsText: "" }

  if (typeof chunk.id === "string") {
    current.id = chunk.id
  }

  if (isRecord(chunk.function)) {
    if (typeof chunk.function.name === "string") {
      current.name = chunk.function.name
    }
    if (typeof chunk.function.arguments === "string") {
      current.argumentsText += chunk.function.arguments
    }
  }

  pendingToolCalls.set(index, current)
}

function* flushToolCalls(pendingToolCalls: Map<number, PendingToolCall>): Iterable<LLMEvent> {
  const ordered = [...pendingToolCalls.entries()].sort(([left], [right]) => left - right)
  pendingToolCalls.clear()

  for (const [, pending] of ordered) {
    if (!pending.name || !isValidToolName(pending.name)) {
      continue
    }

    yield {
      type: "tool_call",
      toolCall: {
        id: pending.id ?? createId("tool"),
        name: pending.name,
        input: parseToolArguments(pending.argumentsText),
      },
    }
  }
}

function* parseNonStreamingResponse(value: unknown): Iterable<LLMEvent> {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    yield { type: "error", error: "OpenAI-compatible response did not contain choices" }
    return
  }

  for (const choice of value.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue
    const message = choice.message
    if (typeof message.content === "string" && message.content.length > 0) {
      yield { type: "text_delta", text: message.content }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const parsed = parseMessageToolCall(toolCall)
        if (parsed) yield { type: "tool_call", toolCall: parsed }
      }
    }
  }

  const usage = parseUsage(value.usage)
  if (usage) {
    yield { type: "usage", usage }
  }

  yield { type: "done" }
}

function parseMessageToolCall(value: unknown): ToolCall | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.function) ||
    typeof value.function.name !== "string" ||
    !isValidToolName(value.function.name)
  ) {
    return undefined
  }

  return {
    id: typeof value.id === "string" ? value.id : createId("tool"),
    name: value.function.name,
    input: parseToolArguments(typeof value.function.arguments === "string" ? value.function.arguments : "{}"),
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlash(baseUrl.trim())
  let url: URL

  try {
    url = new URL(trimmed)
  } catch {
    return trimmed
  }

  const path = trimTrailingSlash(url.pathname)
  if (path === "" || path === "/") {
    url.pathname = "/chat/completions"
  } else if (path === "/models") {
    url.pathname = "/chat/completions"
  } else if (path === "/v1") {
    url.pathname = "/v1/chat/completions"
  } else if (path === "/v1/models") {
    url.pathname = "/v1/chat/completions"
  }

  return trimTrailingSlash(url.toString())
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined

  const inputTokens = readUsageNumber(value.prompt_tokens ?? value.input_tokens)
  const outputTokens = readUsageNumber(value.completion_tokens ?? value.output_tokens)
  const totalTokens = readUsageNumber(value.total_tokens)

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined
  }

  const input = inputTokens ?? 0
  const output = outputTokens ?? 0
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: totalTokens ?? input + output,
  }
}

function readUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isValidToolName(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(value)
}
