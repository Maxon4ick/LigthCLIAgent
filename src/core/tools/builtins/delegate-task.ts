import { createId } from "../../../shared/ids.js"
import type { AppConfig } from "../../config/schema.js"
import type { ToolDefinition } from "../tool.js"

interface DelegateInput {
  prompt: string
  mode?: "build" | "plan" | "explore"
  model?: string
  provider?: string
  cwd?: string
}

export const delegateTaskTool: ToolDefinition<DelegateInput> = {
  name: "delegate_task",
  description:
    "Spawn a focused sub-agent session to complete one task and return its final answer. " +
    "Use when a sub-problem is large, requires a different mode, or should run in isolation. " +
    "The sub-agent has access to all the same tools as this session.",
  kind: "execute",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: true,
    requiresApproval: false,
    tags: ["orchestration", "agent"],
  },
  inputSchema: {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string", description: "The task for the sub-agent." },
      mode: {
        type: "string",
        enum: ["build", "plan", "explore"],
        description: "Agent mode for the sub-session.",
      },
      model: { type: "string", description: "Model name override for the sub-agent." },
      provider: { type: "string", description: "Provider override for the sub-agent." },
      cwd: { type: "string", description: "Working directory override. Defaults to current cwd." },
    },
  },

  async execute(input, ctx) {
    if (!ctx.runChildSession) {
      return { ok: false, error: "delegate_task: runChildSession not available in this context" }
    }

    const model = resolveChildModel(input, ctx.config)
    const childSession = ctx.sessionStore.createSession({
      cwd: input.cwd ?? ctx.cwd,
      model,
      agentId: createId("agent"),
      mode: input.mode ?? "build",
      parentSessionId: ctx.sessionId,
    })

    ctx.sessionStore.addMessage({
      sessionId: childSession.id,
      role: "user",
      parts: [{ type: "text", text: input.prompt }],
    })

    const result = await ctx.runChildSession(childSession.id, ctx.abortSignal)

    return {
      ok: result.ok,
      output: result.assistantText || undefined,
      error: result.error,
    }
  },
}

function resolveChildModel(input: DelegateInput, config: AppConfig): AppConfig["model"] {
  if (input.provider && input.model) {
    return { provider: input.provider, model: input.model }
  }
  const small = config.models.small
  if (small && small.provider !== "mock") return small
  return config.model
}
