import { describe, expect, it } from "vitest"
import { EventBus } from "../src/core/events/event-bus.js"
import { HookPipeline, HookRejectedError } from "../src/core/hooks/hooks.js"
import type { Message } from "../src/core/session/message-types.js"

const message = (text: string): Message => ({
  id: "message",
  sessionId: "session",
  role: "user",
  parts: [{ type: "text", text }],
  createdAt: new Date(0).toISOString(),
})

describe("hook pipeline", () => {
  it("orders hooks, transforms prompt/tool input and fails closed before side effects", async () => {
    const calls: string[] = []
    const events = new EventBus()
    const pipeline = new HookPipeline([
      {
        id: "b",
        priority: 2,
        beforePrompt: ({ prompt }) => { calls.push("b"); return { prompt: `${prompt}!` } },
        beforeTool: ({ toolCall }) => ({ input: { ...(toolCall.input as object), transformed: true } }),
      },
      {
        id: "a",
        priority: 1,
        beforePrompt: () => { calls.push("a") },
      },
    ], events)
    const messages = await pipeline.beforePrompt({
      sessionId: "session",
      messages: [message("hello")],
      systemContext: { text: "", cwd: ".", generatedAt: "", instructionFiles: [], skills: [] },
      abortSignal: new AbortController().signal,
    })
    expect(calls).toEqual(["a", "b"])
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "hello!" }])
    const call = await pipeline.beforeTool({
      sessionId: "session",
      toolCall: { id: "call", name: "tool", input: {} },
      capabilities: ["filesystem.read"],
      providerId: "builtin",
      provenance: "builtin",
      abortSignal: new AbortController().signal,
    })
    expect(call.input).toEqual({ transformed: true })
    const rejecting = new HookPipeline([{
      id: "reject",
      priority: 0,
      beforePrompt: () => ({ reject: "blocked" }),
    }], events)
    await expect(rejecting.beforePrompt({
      sessionId: "session",
      messages: [message("hello")],
      systemContext: { text: "", cwd: ".", generatedAt: "", instructionFiles: [], skills: [] },
      abortSignal: new AbortController().signal,
    })).rejects.toBeInstanceOf(HookRejectedError)
  })
})
