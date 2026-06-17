import type { AppConfig } from "../config/schema.js"
import { askUserQuestionTool } from "./builtins/ask-user-question.js"
import { delegateTaskTool } from "./builtins/delegate-task.js"
import { applyPatchTool } from "./builtins/apply-patch.js"
import { editTool } from "./builtins/edit.js"
import { globTool } from "./builtins/glob.js"
import { grepTool } from "./builtins/grep.js"
import { listDirectoryTool } from "./builtins/list-directory.js"
import { listSkillsTool } from "./builtins/list-skills.js"
import { planEnterTool, planExitTool } from "./builtins/plan-mode.js"
import { projectDiagnosticsTool } from "./builtins/project-diagnostics.js"
import { readFileTool } from "./builtins/read-file.js"
import { shellTool } from "./builtins/shell.js"
import { todoWriteTool } from "./builtins/todo-write.js"
import { useSkillTool } from "./builtins/use-skill.js"
import { webFetchTool } from "./builtins/web-fetch.js"
import { writeFileTool } from "./builtins/write-file.js"
import type { PublicToolDefinition, ToolDefinition } from "./tool.js"

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): PublicToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      kind: tool.kind,
      metadata: {
        safeConcurrent: tool.metadata?.safeConcurrent ?? (tool.kind === "read" || tool.kind === "search"),
        mutatesWorkspace: tool.metadata?.mutatesWorkspace ?? tool.kind === "edit",
        requiresApproval:
          tool.metadata?.requiresApproval ?? (tool.kind === "execute" || tool.kind === "edit" || tool.kind === "network"),
        tags: tool.metadata?.tags ?? [],
      },
    }))
  }
}

export function createDefaultToolRegistry(config: AppConfig): ToolRegistry {
  const registry = new ToolRegistry()
  const disabled = new Set(config.tools.disabled)
  for (const tool of [
    readFileTool,
    listDirectoryTool,
    globTool,
    grepTool,
    shellTool,
    projectDiagnosticsTool,
    webFetchTool,
    writeFileTool,
    editTool,
    applyPatchTool,
    todoWriteTool,
    planEnterTool,
    planExitTool,
    askUserQuestionTool,
    listSkillsTool,
    useSkillTool,
    delegateTaskTool,
  ]) {
    if (!disabled.has(tool.name)) {
      registry.register(tool)
    }
  }
  return registry
}
