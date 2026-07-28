import type { EventBus } from "../events/event-bus.js"
import type { Message } from "../session/message-types.js"
import type { PublicToolDefinition } from "../tools/tool.js"

export interface TokenEstimator {
  readonly id: string
  estimateText(text: string): number
  estimateMessages(messages: readonly Message[]): number
  estimateTools(tools: readonly PublicToolDefinition[]): number
}

export interface ContextCompactorInput {
  previousSummary?: string
  removedMessages: readonly Message[]
}

export interface ContextCompactor {
  readonly id: string
  compact(input: ContextCompactorInput): Promise<string> | string
}

export interface ContextBudgetInput {
  sessionId: string
  systemContext: string
  skillCatalog?: string
  summary?: string
  messages: readonly Message[]
  tools: readonly PublicToolDefinition[]
  maxContextTokens: number
  reserveOutputTokens: number
  compactionThreshold: number
}

export interface ContextBudgetResult {
  status: "ready" | "compacted" | "context_limit"
  messages: Message[]
  summary?: string
  keepLastMessages: number
  tokensBefore: number
  tokensAfter: number
  removedMessages: number
}

export interface ContextBudgetManager {
  prepare(input: ContextBudgetInput): Promise<ContextBudgetResult>
}

export class DefaultContextBudgetManager implements ContextBudgetManager {
  constructor(
    readonly estimator: TokenEstimator = heuristicTokenEstimator,
    readonly compactor: ContextCompactor = deterministicContextCompactor,
    private readonly events?: EventBus,
  ) {}

  async prepare(input: ContextBudgetInput): Promise<ContextBudgetResult> {
    const fixed = this.fixedTokens(input)
    const messageTokens = this.estimator.estimateMessages(input.messages)
    const tokensBefore = fixed + messageTokens + input.reserveOutputTokens
    const threshold = Math.floor(input.maxContextTokens * input.compactionThreshold)
    if (tokensBefore <= threshold) {
      return {
        status: "ready",
        messages: [...input.messages],
        summary: input.summary,
        keepLastMessages: input.messages.length,
        tokensBefore,
        tokensAfter: tokensBefore,
        removedMessages: 0,
      }
    }

    const groups = messageGroups(input.messages)
    let startGroup = 0
    while (startGroup < groups.length - 1) {
      if (!groups[startGroup]?.removable) {
        break
      }
      const candidate = groups.slice(startGroup + 1).flatMap((group) => group.messages)
      const candidateTokens =
        fixed + this.estimator.estimateMessages(candidate) + input.reserveOutputTokens
      startGroup += 1
      if (candidateTokens <= threshold) break
    }

    const retained = groups.slice(startGroup).flatMap((group) => group.messages)
    const removedCount = input.messages.length - retained.length
    if (removedCount === 0) {
      return contextLimit(input, tokensBefore, fixed + messageTokens + input.reserveOutputTokens)
    }
    const removed = input.messages.slice(0, removedCount)
    const summary = await this.compactor.compact({
      previousSummary: input.summary,
      removedMessages: removed,
    })
    const tokensAfter =
      this.fixedTokens({ ...input, summary }) +
      this.estimator.estimateMessages(retained) +
      input.reserveOutputTokens
    if (tokensAfter > input.maxContextTokens) {
      return contextLimit(input, tokensBefore, tokensAfter, retained, summary, removedCount)
    }

    this.events?.publish({
      type: "context.compacted",
      payload: {
        sessionId: input.sessionId,
        tokensBefore,
        tokensAfter,
        removedMessages: removedCount,
        retainedMessages: retained.length,
        estimatorId: this.estimator.id,
      },
    })
    return {
      status: "compacted",
      messages: retained,
      summary,
      keepLastMessages: retained.length,
      tokensBefore,
      tokensAfter,
      removedMessages: removedCount,
    }
  }

  private fixedTokens(input: Pick<
    ContextBudgetInput,
    "systemContext" | "skillCatalog" | "summary" | "tools"
  >): number {
    return this.estimator.estimateText(input.systemContext) +
      this.estimator.estimateText(input.skillCatalog ?? "") +
      this.estimator.estimateText(input.summary ?? "") +
      this.estimator.estimateTools(input.tools)
  }
}

export const heuristicTokenEstimator: TokenEstimator = {
  id: "chars-v1",
  estimateText: (text) => Math.ceil(text.length / 4),
  estimateMessages: (messages) => Math.ceil(stableStringify(messages).length / 4),
  estimateTools: (tools) => Math.ceil(stableStringify(tools).length / 4),
}

export const deterministicContextCompactor: ContextCompactor = {
  id: "deterministic-v1",
  compact(input) {
    const lines = input.removedMessages.flatMap((message) => {
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
      return text ? [`${message.role}: ${text}`] : []
    })
    const addition = lines.length > 0 ? lines.join("\n") : "Earlier completed tool interaction was compacted."
    return [input.previousSummary, addition].filter(Boolean).join("\n").slice(-8_000)
  },
}

interface MessageGroup {
  messages: Message[]
  removable: boolean
}

/** Groups completed conversational turns so tool call/result pairs move together. */
export function messageGroups(messages: readonly Message[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let current: Message[] = []
  const flush = () => {
    if (current.length === 0) return
    const calls = new Set(current.flatMap((message) =>
      message.parts.filter((part) => part.type === "tool_call").map((part) => part.toolCallId),
    ))
    const results = new Set(current.flatMap((message) =>
      message.parts.filter((part) => part.type === "tool_result").map((part) => part.toolCallId),
    ))
    groups.push({
      messages: current,
      removable: [...calls].every((id) => results.has(id)),
    })
    current = []
  }

  for (const message of messages) {
    if (message.role === "user" && current.length > 0) flush()
    current.push(message)
  }
  flush()
  if (groups.length > 0) groups[groups.length - 1] = { ...groups[groups.length - 1], removable: false }
  return groups
}

function contextLimit(
  input: ContextBudgetInput,
  tokensBefore: number,
  tokensAfter: number,
  messages: readonly Message[] = input.messages,
  summary = input.summary,
  removedMessages = 0,
): ContextBudgetResult {
  return {
    status: "context_limit",
    messages: [...messages],
    summary,
    keepLastMessages: messages.length,
    tokensBefore,
    tokensAfter,
    removedMessages,
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
  })
}
