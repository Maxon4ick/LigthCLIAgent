import { createId } from "../../shared/ids.js"
import type { LLMEvent, ProviderAdapter, ProviderRequest } from "./provider.js"

export class MockProvider implements ProviderAdapter {
  readonly id = "mock"

  async *stream(input: ProviderRequest): AsyncIterable<LLMEvent> {
    // After tool results are in the history, give a final text answer instead of looping.
    if (input.messages.some((m) => m.role === "tool")) {
      yield { type: "text_delta", text: "Done." }
      yield { type: "done" }
      return
    }

    const prompt = lastUserText(input).trim()
    const normalized = prompt.toLowerCase()

    if (normalized.includes("read package.json")) {
      yield { type: "text_delta", text: "I will read package.json.\n" }
      yield {
        type: "tool_call",
        toolCall: {
          id: createId("tool"),
          name: "read_file",
          input: { path: "package.json" },
        },
      }
      yield { type: "done" }
      return
    }

    if (normalized.startsWith("grep ")) {
      const pattern = prompt.slice("grep ".length).trim()
      yield { type: "text_delta", text: `I will search for "${pattern}".\n` }
      yield {
        type: "tool_call",
        toolCall: {
          id: createId("tool"),
          name: "grep",
          input: { pattern },
        },
      }
      yield { type: "done" }
      return
    }

    if (normalized.startsWith("run shell ")) {
      const command = prompt.slice("run shell ".length).trim()
      yield { type: "text_delta", text: `I will request shell execution for: ${command}\n` }
      yield {
        type: "tool_call",
        toolCall: {
          id: createId("tool"),
          name: "shell",
          input: { command },
        },
      }
      yield { type: "done" }
      return
    }

    if (normalized.includes("edit sample.txt")) {
      yield { type: "text_delta", text: "I will edit sample.txt.\n" }
      yield {
        type: "tool_call",
        toolCall: {
          id: createId("tool"),
          name: "apply_patch",
          input: { path: "sample.txt", oldText: "before", newText: "after" },
        },
      }
      yield { type: "done" }
      return
    }

    yield { type: "text_delta", text: `Mock response: received "${prompt || "empty prompt"}".` }
    yield { type: "done" }
  }
}

function lastUserText(input: ProviderRequest): string {
  const message = [...input.messages].reverse().find((item) => item.role === "user")
  if (!message) {
    return ""
  }

  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}
