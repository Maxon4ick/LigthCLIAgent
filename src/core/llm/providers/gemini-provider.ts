import { createId } from "../../../shared/ids.js"
import { redactSecrets } from "../../security/redaction.js"
import type { Message, MessagePart, TokenUsage } from "../../session/message-types.js"
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

interface GeminiContent {
  role: "user" | "model"
  parts: Array<Record<string, unknown>>
}

export class GeminiGenerativeLanguageProvider implements ProviderAdapter {
  readonly id = "gemini"

  constructor(private readonly connection: ApiConnection) {}

  async *stream(input: ProviderRequest): AsyncIterable<LLMEvent> {
    const sanitized = sanitizeProviderRequest(input)
    const url = new URL(
      `${trimTrailingSlash(this.connection.baseUrl)}/v1beta/models/${encodeURIComponent(input.session.model.model)}:streamGenerateContent`,
    )
    url.searchParams.set("alt", "sse")
    url.searchParams.set("key", this.connection.apiKey)

    const response = await fetchWithProviderPolicy(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.connection.headers,
      },
      body: JSON.stringify({
        ...this.connection.body,
        systemInstruction: {
          parts: [{ text: sanitized.systemContext.text }],
        },
        contents: sanitized.messages.flatMap(toGeminiContents),
        tools: sanitized.tools.length > 0 ? [{ functionDeclarations: sanitized.tools.map(toGeminiTool) }] : undefined,
      }),
      signal: input.abortSignal,
    })

    if (!response.ok) {
      const body = redactSecrets(await response.text())
      throw new Error(`Gemini request failed (${response.status}): ${body}`)
    }

    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text/event-stream")) {
      yield* parseResponse(await response.json())
      return
    }

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
        yield* parseResponse(parsed)
      }
    }
    yield { type: "done" }
  }
}

function toGeminiContents(message: Message): GeminiContent[] {
  if (message.role === "system") {
    return []
  }

  if (message.role === "tool") {
    return [
      {
        role: "user",
        parts: message.parts
          .filter((part) => part.type === "tool_result")
          .map((part) => ({
            functionResponse: {
              name: part.name,
              response: { output: part.output, error: part.error },
            },
          })),
      },
    ]
  }

  const parts: Array<Record<string, unknown>> = []
  const text = textParts(message.parts)
  if (text) {
    parts.push({ text })
  }
  for (const part of message.parts) {
    if (part.type === "tool_call") {
      parts.push({
        functionCall: {
          name: part.name,
          args: isRecord(part.input) ? part.input : {},
        },
      })
    }
  }

  return [
    {
      role: message.role === "assistant" ? "model" : "user",
      parts,
    },
  ]
}

function textParts(parts: MessagePart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function toGeminiTool(tool: PublicToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }
}

function* parseResponse(value: unknown): Iterable<LLMEvent> {
  if (!isRecord(value)) return
  const candidates = value.candidates
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue
      for (const part of candidate.content.parts) {
        if (!isRecord(part)) continue
        if (typeof part.text === "string") {
          yield { type: "text_delta", text: part.text }
        }
        if (isRecord(part.functionCall) && typeof part.functionCall.name === "string") {
          yield {
            type: "tool_call",
            toolCall: {
              id: createId("tool"),
              name: part.functionCall.name,
              input: isRecord(part.functionCall.args) ? part.functionCall.args : {},
            },
          }
        }
      }
    }
  }

  const usage = parseUsage(value.usageMetadata)
  if (usage) {
    yield { type: "usage", usage }
  }
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = readUsageNumber(value.promptTokenCount) ?? 0
  const output = readUsageNumber(value.candidatesTokenCount) ?? 0
  const total = readUsageNumber(value.totalTokenCount) ?? input + output
  if (input === 0 && output === 0 && total === 0) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
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
