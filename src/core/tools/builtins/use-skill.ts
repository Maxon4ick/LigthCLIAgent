import {
  loadIndexedSkill,
  loadSkillIndex,
  resolveSkill,
  workspaceSkillSources,
} from "../../context/skills.js"
import type { ToolDefinition } from "../tool.js"

interface UseSkillInput {
  name: string
  resource?: string
}

interface UseSkillOutput {
  name: string
  path: string
  description?: string
  body: string
  resource?: string
}

export const useSkillTool: ToolDefinition<unknown, UseSkillOutput> = {
  name: "use_skill",
  description: "Load the full body of a discovered local skill by name or path.",
  kind: "read",
  metadata: {
    safeConcurrent: true,
    mutatesWorkspace: false,
    requiresApproval: false,
    tags: ["workflow", "skills"],
  },
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      resource: {
        type: "string",
        description: "Optional resource path relative to the selected skill directory.",
      },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    const index = await loadSkillIndex(
      context.cwd,
      context.skillSources ?? workspaceSkillSources(context.config.agent.skillPaths),
    )
    let skill
    try {
      skill = resolveSkill(index, parsed.name)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const loaded = await loadIndexedSkill(index, skill, {
      cwd: context.cwd,
      config: context.config,
      events: context.eventBus,
      abortSignal: context.abortSignal,
      resource: parsed.resource,
    })
    return {
      ok: true,
      output: {
        name: skill.name,
        path: skill.path,
        description: skill.description,
        body: loaded.body,
        resource: parsed.resource,
      },
    }
  },
}

function parseInput(input: unknown): UseSkillInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("use_skill input must be an object")
  }

  const name = (input as { name?: unknown }).name
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("use_skill.name must be a non-empty string")
  }

  const resource = (input as { resource?: unknown }).resource
  if (resource !== undefined && (typeof resource !== "string" || resource.trim().length === 0)) {
    throw new Error("use_skill.resource must be a non-empty string")
  }
  return { name: name.trim(), resource: typeof resource === "string" ? resource.trim() : undefined }
}
