import { loadWorkspaceSkills, type SkillInfo } from "../../context/skills.js"
import type { ToolDefinition } from "../tool.js"

interface ListSkillsOutput {
  skills: SkillInfo[]
}

export const listSkillsTool: ToolDefinition<unknown, ListSkillsOutput> = {
  name: "list_skills",
  description: "List local workspace skills discovered from configured skill paths.",
  kind: "read",
  metadata: {
    safeConcurrent: true,
    mutatesWorkspace: false,
    requiresApproval: false,
    tags: ["agent", "skills"],
  },
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(_input, context) {
    return {
      ok: true,
      output: {
        skills: await loadWorkspaceSkills(context.cwd, context.config.agent.skillPaths),
      },
    }
  },
}
