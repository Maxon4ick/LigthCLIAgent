import { readFile } from "node:fs/promises"
import { loadWorkspaceSkills } from "../../context/skills.js"
import { resolveInsideCwd } from "./path-utils.js"
import type { ToolDefinition } from "../tool.js"

interface UseSkillInput {
  name: string
}

interface UseSkillOutput {
  name: string
  path: string
  description?: string
  body: string
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
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    const skills = await loadWorkspaceSkills(context.cwd, context.config.agent.skillPaths)
    const requested = parsed.name.toLowerCase()
    const skill = skills.find((item) => item.name.toLowerCase() === requested || item.path.toLowerCase() === requested)
    if (!skill) {
      return {
        ok: false,
        error: `Skill not found: ${parsed.name}`,
      }
    }

    const filePath = resolveInsideCwd(context.cwd, skill.path)
    return {
      ok: true,
      output: {
        name: skill.name,
        path: skill.path,
        description: skill.description,
        body: await readFile(filePath, "utf8"),
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

  return { name: name.trim() }
}
