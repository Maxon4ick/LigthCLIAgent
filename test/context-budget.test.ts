import { describe, expect, it } from "vitest"
import {
  DefaultContextBudgetManager,
  heuristicTokenEstimator,
} from "../src/core/context/context-budget.js"
import type { Message } from "../src/core/session/message-types.js"

function messages(): Message[] {
  return [
    {
      id: "a",
      sessionId: "s",
      role: "user",
      parts: [{ type: "text", text: "old ".repeat(200) }],
      createdAt: "1",
    },
    {
      id: "b",
      sessionId: "s",
      role: "assistant",
      parts: [{ type: "tool_call", toolCallId: "call", name: "read", input: {} }],
      createdAt: "2",
    },
    {
      id: "c",
      sessionId: "s",
      role: "tool",
      parts: [{ type: "tool_result", toolCallId: "call", name: "read", output: "ok" }],
      createdAt: "3",
    },
    {
      id: "d",
      sessionId: "s",
      role: "user",
      parts: [{ type: "text", text: "latest" }],
      createdAt: "4",
    },
  ]
}

describe("context budget", () => {
  it("is deterministic and compacts complete message groups", async () => {
    const manager = new DefaultContextBudgetManager()
    const input = {
      sessionId: "s",
      systemContext: "system",
      messages: messages(),
      tools: [],
      maxContextTokens: 250,
      reserveOutputTokens: 20,
      compactionThreshold: 0.85,
    }
    const result = await manager.prepare(input)
    expect(result.status).toBe("compacted")
    expect(result.messages.at(-1)?.parts).toEqual([{ type: "text", text: "latest" }])
    const retainedCalls = new Set(result.messages.flatMap((item) =>
      item.parts.filter((part) => part.type === "tool_call").map((part) => part.toolCallId),
    ))
    expect(result.messages.flatMap((item) =>
      item.parts.filter((part) => part.type === "tool_result").map((part) => part.toolCallId),
    ).every((id) => retainedCalls.has(id))).toBe(true)
    expect(heuristicTokenEstimator.estimateMessages(messages()))
      .toBe(heuristicTokenEstimator.estimateMessages(messages()))
  })

  it("returns context_limit when fixed context cannot fit", async () => {
    const result = await new DefaultContextBudgetManager().prepare({
      sessionId: "s",
      systemContext: "x".repeat(10_000),
      messages: [],
      tools: [],
      maxContextTokens: 100,
      reserveOutputTokens: 20,
      compactionThreshold: 0.85,
    })
    expect(result.status).toBe("context_limit")
  })
})
