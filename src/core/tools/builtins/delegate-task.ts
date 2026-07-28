import { createId } from "../../../shared/ids.js"
import type { AppConfig } from "../../config/schema.js"
import { resolveRealInsideCwd } from "./path-utils.js"
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
    "The sub-agent uses the same permission policy as this session; its mode may further restrict tools.",
  kind: "delegate",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: false,
    requiresApproval: false,
    capabilities: ["agent.delegate"],
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
    if ((ctx.delegationDepth ?? 0) >= ctx.config.agent.maxDelegationDepth) {
      return {
        ok: false,
        error: `delegate_task: maximum delegation depth ${ctx.config.agent.maxDelegationDepth} reached`,
      }
    }

    const parent = ctx.sessionStore.getSession(ctx.sessionId)
    const model = resolveChildModel(input, parent.model, ctx.config)
    const cwd = input.cwd ? await resolveRealInsideCwd(ctx.cwd, input.cwd) : ctx.cwd
    const childSession = ctx.sessionStore.createSession({
      cwd,
      model,
      agentId: createId("agent"),
      mode: input.mode ?? "build",
      parentSessionId: ctx.sessionId,
    })
    ctx.sessionStore.updateSession(childSession.id, {
      metadata: { delegationDepth: (ctx.delegationDepth ?? 0) + 1 },
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

function resolveChildModel(
  input: DelegateInput,
  parentModel: AppConfig["model"],
  config: AppConfig,
): AppConfig["model"] {
  if (input.provider || input.model) {
    return {
      provider: input.provider ?? parentModel.provider,
      model: input.model ?? parentModel.model,
    }
  }
  const small = config.models.small
  if (small && small.provider !== "mock") return small
  return parentModel
}
