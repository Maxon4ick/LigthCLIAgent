import type { ToolDefinition } from "../tool.js"

interface AskUserQuestionInput {
  question: string
  context?: string
}

interface AskUserQuestionOutput {
  question: string
  context?: string
  status: "pending_user_input"
}

export const askUserQuestionTool: ToolDefinition<unknown, AskUserQuestionOutput> = {
  name: "ask_user_question",
  description: "Emit a structured question for the user when progress is blocked by missing intent.",
  kind: "other",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: false,
    requiresApproval: false,
    tags: ["agent", "question"],
  },
  inputSchema: {
    type: "object",
    required: ["question"],
    properties: {
      question: { type: "string" },
      context: { type: "string" },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    context.eventBus.publish({
      type: "agent.question",
      payload: {
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        question: parsed.question,
        context: parsed.context,
      },
    })

    return {
      ok: true,
      output: {
        question: parsed.question,
        context: parsed.context,
        status: "pending_user_input",
      },
    }
  },
}

function parseInput(input: unknown): AskUserQuestionInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("ask_user_question input must be an object")
  }

  const record = input as Record<string, unknown>
  if (typeof record.question !== "string" || record.question.length === 0) {
    throw new Error("ask_user_question.question must be a non-empty string")
  }
  if (record.context !== undefined && typeof record.context !== "string") {
    throw new Error("ask_user_question.context must be a string")
  }

  return {
    question: record.question,
    context: record.context,
  }
}
