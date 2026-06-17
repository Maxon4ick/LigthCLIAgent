import http, { type IncomingMessage, type ServerResponse } from "node:http"
import { describe, expect, it } from "vitest"
import { AnthropicMessagesProvider } from "../src/core/llm/providers/anthropic-messages-provider.js"
import { GeminiGenerativeLanguageProvider } from "../src/core/llm/providers/gemini-provider.js"
import type { LLMEvent, ProviderRequest } from "../src/core/llm/provider.js"

describe("provider contract fixtures", () => {
  it("normalizes Anthropic streaming text, tool calls, and usage", async () => {
    const fake = await startFakeServer((_request, response) => {
      writeSse(response, [
        { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\"}" } },
        { type: "message_delta", usage: { input_tokens: 10, output_tokens: 4 } },
        { type: "message_stop" },
      ])
    })

    try {
      const provider = new AnthropicMessagesProvider({ baseUrl: fake.baseUrl, apiKey: "test-key" })
      const events = await collect(provider.stream(providerRequest("anthropic", "claude-test")))

      expect(events).toContainEqual({ type: "text_delta", text: "hello " })
      expect(events).toContainEqual({
        type: "tool_call",
        toolCall: { id: "toolu_1", name: "read_file", input: { path: "README.md" } },
      })
      expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } })
      expect(events.some((event) => event.type === "done")).toBe(true)
    } finally {
      await fake.close()
    }
  })

  it("normalizes Gemini streaming text, function calls, and usage", async () => {
    const fake = await startFakeServer((_request, response) => {
      writeSse(response, [
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "hello gemini" },
                  { functionCall: { name: "read_file", args: { path: "README.md" } } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 },
        },
      ])
    })

    try {
      const provider = new GeminiGenerativeLanguageProvider({ baseUrl: fake.baseUrl, apiKey: "test-key" })
      const events = await collect(provider.stream(providerRequest("gemini", "gemini-test")))

      expect(events).toContainEqual({ type: "text_delta", text: "hello gemini" })
      expect(events.find((event) => event.type === "tool_call")).toMatchObject({
        type: "tool_call",
        toolCall: { name: "read_file", input: { path: "README.md" } },
      })
      expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } })
      expect(events.at(-1)).toEqual({ type: "done" })
    } finally {
      await fake.close()
    }
  })
})

async function collect(events: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const collected: LLMEvent[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

function providerRequest(provider: string, model: string): ProviderRequest {
  const now = "2026-06-16T00:00:00.000Z"
  return {
    session: {
      id: "ses_test",
      cwd: process.cwd(),
      status: "idle",
      model: { provider, model },
      agentId: "default",
      mode: "build",
      createdAt: now,
      updatedAt: now,
    },
    systemContext: {
      text: "system",
      cwd: process.cwd(),
      generatedAt: now,
      instructionFiles: [],
      skills: [],
    },
    messages: [
      {
        id: "msg_user",
        sessionId: "ses_test",
        role: "user",
        parts: [{ type: "text", text: "inspect README" }],
        createdAt: now,
      },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        kind: "read",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        metadata: { safeConcurrent: true, mutatesWorkspace: false, requiresApproval: false, tags: ["files"] },
      },
    ],
  }
}

async function startFakeServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" })
      response.end(error instanceof Error ? error.message : String(error))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  if (typeof address !== "object" || !address) {
    throw new Error("Fake server did not bind to a TCP port")
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function writeSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
  })

  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  response.end()
}
