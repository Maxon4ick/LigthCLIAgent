import type { ToolDefinition } from "../tool.js"

interface PlanEnterInput {
  title?: string
  summary?: string
}

interface PlanExitInput {
  summary?: string
}

interface PlanModeOutput {
  mode: "plan" | "build"
  title?: string
  summary?: string
}

export const planEnterTool: ToolDefinition<unknown, PlanModeOutput> = {
  name: "plan_enter",
  description: "Switch the current session into read-only planning mode.",
  kind: "other",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: false,
    requiresApproval: false,
    tags: ["agent", "mode", "plan"],
  },
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
    },
  },
  async execute(input, context) {
    const parsed = parsePlanEnterInput(input)
    const session = context.sessionStore.updateSession(context.sessionId, {
      mode: "plan",
      title: parsed.title,
      summary: parsed.summary,
    })

    return {
      ok: true,
      output: {
        mode: "plan",
        title: session.title,
        summary: session.summary,
      },
    }
  },
}

export const planExitTool: ToolDefinition<unknown, PlanModeOutput> = {
  name: "plan_exit",
  description: "Switch the current session back to build mode after planning.",
  kind: "other",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: false,
    requiresApproval: false,
    tags: ["agent", "mode", "plan"],
  },
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
    },
  },
  async execute(input, context) {
    const parsed = parsePlanExitInput(input)
    const session = context.sessionStore.updateSession(context.sessionId, {
      mode: "build",
      summary: parsed.summary,
    })

    return {
      ok: true,
      output: {
        mode: "build",
        title: session.title,
        summary: session.summary,
      },
    }
  },
}

function parsePlanEnterInput(input: unknown): PlanEnterInput {
  if (input === undefined) {
    return {}
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("plan_enter input must be an object")
  }
  const record = input as Record<string, unknown>
  return {
    title: readOptionalString(record.title, "plan_enter.title"),
    summary: readOptionalString(record.summary, "plan_enter.summary"),
  }
}

function parsePlanExitInput(input: unknown): PlanExitInput {
  if (input === undefined) {
    return {}
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("plan_exit input must be an object")
  }
  const record = input as Record<string, unknown>
  return {
    summary: readOptionalString(record.summary, "plan_exit.summary"),
  }
}

function readOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}
