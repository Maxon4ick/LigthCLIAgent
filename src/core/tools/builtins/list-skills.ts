import {
  loadSkillIndex,
  workspaceSkillSources,
  type SkillDiagnostic,
  type SkillInfo,
} from "../../context/skills.js"
import type { ToolDefinition } from "../tool.js"

interface ListSkillsOutput {
  skills: SkillInfo[]
  diagnostics: SkillDiagnostic[]
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
    const index = await loadSkillIndex(
      context.cwd,
      context.skillSources ?? workspaceSkillSources(context.config.agent.skillPaths),
    )
    return {
      ok: true,
      output: index,
    }
  },
}
