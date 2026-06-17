import http, { type IncomingMessage, type ServerResponse } from "node:http"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig, type AppConfig } from "../src/core/config/schema.js"
import { addUserPrompt, createRuntime, createSession } from "../src/core/runtime.js"

describe("OpenAICompatibleProvider", () => {
  it("streams text from a local OpenAI-compatible chat completions endpoint", async () => {
    const requests: Array<{ authorization?: string; body: unknown }> = []
    const fake = await startFakeOpenAI(async (request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(await readBody(request)) as unknown,
      })

      writeSse(response, [
        { choices: [{ delta: { content: "hello " } }] },
        { choices: [{ delta: { content: "from compatible" } }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
      ])
    })

    try {
      const runtime = createRuntime(openAIConfig(fake.baseUrl), process.cwd())
      const session = createSession(runtime)
      addUserPrompt(runtime, session.id, "hello")

      const result = await runtime.runner.run(session.id)

      expect(result.assistantText).toBe("hello from compatible")
      expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 })
      expect(runtime.sessions.listMessages(session.id).find((message) => message.role === "assistant")?.usage).toEqual({
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      })
      expect(runtime.events.history({ sessionId: session.id }).find((event) => event.type === "llm.usage")).toMatchObject({
        payload: {
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18,
          },
        },
      })
      expect(requests[0]?.authorization).toBe("Bearer test-key")
      expect(requests[0]?.body).toMatchObject({
        model: "test-model",
        stream: true,
        stream_options: { include_usage: true },
      })
    } finally {
      await fake.close()
    }
  })

  it("normalizes OpenAI-compatible base and model catalog URLs to chat completions", async () => {
    const requestedUrls: string[] = []
    const fake = await startFakeOpenAI((request, response) => {
      requestedUrls.push(request.url ?? "")
      writeSse(response, [{ choices: [{ delta: { content: "ok" } }] }])
    })

    const cases = [
      { baseUrl: fake.baseUrl, expectedPath: "/chat/completions" },
      { baseUrl: `${fake.baseUrl}/models`, expectedPath: "/chat/completions" },
      { baseUrl: `${fake.baseUrl}/v1`, expectedPath: "/v1/chat/completions" },
      { baseUrl: `${fake.baseUrl}/v1/models`, expectedPath: "/v1/chat/completions" },
      { baseUrl: `${fake.baseUrl}/v1/chat/completions`, expectedPath: "/v1/chat/completions" },
      { baseUrl: `${fake.baseUrl}/api/generate`, expectedPath: "/api/generate" },
    ]

    try {
      for (const testCase of cases) {
        requestedUrls.length = 0
        const runtime = createRuntime(openAIConfig(testCase.baseUrl), process.cwd())
        const session = createSession(runtime)
        addUserPrompt(runtime, session.id, "hello")

        await runtime.runner.run(session.id)

        expect(requestedUrls[0]).toBe(testCase.expectedPath)
      }
    } finally {
      await fake.close()
    }
  })

  it("parses streamed tool calls and executes them through the scheduler", async () => {
    let requestCount = 0
    const fake = await startFakeOpenAI(async (_request, response) => {
      requestCount += 1
      if (requestCount === 1) {
        writeSse(response, [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_read",
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: "{\"path\"",
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: ":\"package.json\"}",
                      },
                    },
                  ],
                },
              },
            ],
          },
        ])
      } else {
        writeSse(response, [{ choices: [{ delta: { content: "Done reading package.json." } }] }])
      }
    })

    try {
      const runtime = createRuntime(openAIConfig(fake.baseUrl), process.cwd())
      const session = createSession(runtime)
      addUserPrompt(runtime, session.id, "please inspect package.json")

      const result = await runtime.runner.run(session.id)

      expect(result.toolResults).toHaveLength(1)
      expect(result.toolResults[0]).toMatchObject({
        toolCallId: "call_read",
        name: "read_file",
        ok: true,
      })
    } finally {
      await fake.close()
    }
  })
})

function openAIConfig(baseUrl: string): AppConfig {
  return mergeConfig(defaultConfig, {
    model: {
      provider: "openai-compatible",
      model: "test-model",
    },
    providers: {
      openaiCompatible: {
        baseUrl,
        apiKey: "test-key",
      },
    },
    storage: {
      kind: "memory",
    },
  })
}

async function startFakeOpenAI(
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
  response.end("data: [DONE]\n\n")
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })
}
