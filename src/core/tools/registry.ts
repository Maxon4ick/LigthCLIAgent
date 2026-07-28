import type { AppConfig } from "../config/schema.js"
import type { Capability } from "../permissions/policy.js"
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
import {
  compileJsonSchema,
  type CompiledJsonSchema,
} from "./json-schema.js"
import type {
  PublicToolDefinition,
  ToolDefinition,
  ToolProvider,
  ToolProviderContext,
  ToolProvenance,
} from "./tool.js"

export interface RegisteredTool {
  qualifiedName: string
  publicName: string
  providerId: string
  provenance: ToolProvenance
  definition: ToolDefinition
  validator: CompiledJsonSchema
}

export interface ToolRegistration {
  providerId?: string
  provenance?: ToolProvenance
  namespace?: string
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  register(tool: ToolDefinition, registration: ToolRegistration = {}): void {
    this.registerBatch([tool], registration)
  }

  /** Validate and compile a whole provider atomically before mutating the registry. */
  registerBatch(tools: readonly ToolDefinition[], registration: ToolRegistration = {}): void {
    const providerId = normalizeIdentifier(registration.providerId ?? "builtin", "provider id")
    const provenance = registration.provenance ?? "builtin"
    const namespace = registration.namespace === undefined
      ? provenance === "builtin" ? undefined : providerId
      : normalizeNamespace(registration.namespace)
    const prepared = tools.map((tool) => prepareTool(tool, { providerId, provenance, namespace }))
    const names = new Set<string>()
    for (const entry of prepared) {
      if (names.has(entry.qualifiedName)) {
        throw new Error(`Duplicate tool name in provider "${providerId}": "${entry.qualifiedName}"`)
      }
      names.add(entry.qualifiedName)
      const current = this.tools.get(entry.qualifiedName)
      if (current) {
        throw new Error(
          `Tool name conflict: "${entry.qualifiedName}" from provider "${providerId}" ` +
          `conflicts with provider "${current.providerId}"`,
        )
      }
      if (provenance !== "builtin" && this.tools.has(entry.publicName)) {
        throw new Error(`External provider "${providerId}" cannot replace built-in tool "${entry.publicName}"`)
      }
    }
    for (const entry of prepared) this.tools.set(entry.qualifiedName, entry)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition
  }

  getRegistered(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  listRegistered(): RegisteredTool[] {
    return [...this.tools.values()]
  }

  list(): PublicToolDefinition[] {
    return [...this.tools.values()].map(({ definition: tool, providerId, provenance }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      kind: tool.kind,
      metadata: {
        safeConcurrent: tool.metadata?.safeConcurrent ?? (tool.kind === "read" || tool.kind === "search"),
        mutatesWorkspace: tool.metadata?.mutatesWorkspace ?? tool.kind === "edit",
        requiresApproval:
          tool.metadata?.requiresApproval ??
            (tool.kind === "execute" || tool.kind === "edit" || tool.kind === "network"),
        capabilities: capabilitiesForDefinition(tool),
        provenance,
        providerId,
        tags: tool.metadata?.tags ?? [],
      },
    }))
  }
}

export class BuiltInToolProvider implements ToolProvider {
  readonly id = "builtin"
  readonly provenance = "builtin" as const
  load(): ToolDefinition[] {
    return listBuiltinTools()
  }
}

export function createDefaultToolRegistry(config: AppConfig): ToolRegistry {
  const registry = new ToolRegistry()
  const disabled = new Set(config.tools.disabled)
  registry.registerBatch(
    listBuiltinTools().filter((tool) => !disabled.has(tool.name)),
    { providerId: "builtin", provenance: "builtin" },
  )
  return registry
}

export function listBuiltinTools(): ToolDefinition[] {
  return [
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
  ]
}

export const builtinToolProvider = new BuiltInToolProvider()

export async function loadToolProviders(
  registry: ToolRegistry,
  providers: readonly ToolProvider[],
  context: ToolProviderContext,
  disabledProviders: readonly string[] = [],
  disabledTools: readonly string[] = [],
  initializedSink?: ToolProvider[],
): Promise<ToolProvider[]> {
  const disabledProviderSet = new Set(disabledProviders.map((id) => normalizeIdentifier(id, "provider id")))
  const disabledToolSet = new Set(disabledTools)
  const initialized: ToolProvider[] = []
  const seenProviders = new Set<string>()
  for (const provider of providers) {
    const providerId = normalizeIdentifier(provider.id, "provider id")
    if (seenProviders.has(providerId)) throw new Error(`Duplicate tool provider id "${providerId}"`)
    seenProviders.add(providerId)
    if (disabledProviderSet.has(providerId)) continue
    const provenance = provider.provenance ?? "local"
    const namespace = provider.namespace === undefined
      ? provenance === "builtin" ? undefined : providerId
      : normalizeNamespace(provider.namespace)
    initializedSink?.push(provider)
    let loaded: ToolDefinition[]
    const started = Date.now()
    try {
      loaded = await provider.load(context)
    } catch (error) {
      context.events.publish({
        type: "runtime.extension.failed",
        payload: {
          extensionId: providerId,
          provenance,
          durationMs: Date.now() - started,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        },
      })
      if (provider.failureMode === "isolate") continue
      throw error
    }
    initialized.push(provider)
    if (provider.requiresExplicitCapabilities) {
      const missing = loaded.find((tool) => !tool.metadata?.capabilities?.length)
      if (missing) throw new Error(`External tool "${missing.name}" must declare capabilities`)
    }
    const tools = loaded.filter((tool) => {
      const publicName = normalizeIdentifier(tool.name, "tool name", 64)
      const qualifiedName = namespace ? `${namespace}__${publicName}` : publicName
      return !disabledToolSet.has(publicName) && !disabledToolSet.has(qualifiedName)
    })
    registry.registerBatch(tools, { providerId, provenance, namespace })
    context.events.publish({
      type: "tool.provider.loaded",
      payload: {
        extensionId: providerId,
        provenance,
        durationMs: Date.now() - started,
      },
    })
    context.events.publish({
      type: "runtime.extension.loaded",
      payload: {
        extensionId: providerId,
        provenance,
        durationMs: Date.now() - started,
      },
    })
  }
  return initialized
}

export function capabilitiesForKind(kind: ToolDefinition["kind"]): Capability[] {
  if (kind === "read" || kind === "search") return ["filesystem.read"]
  if (kind === "edit") return ["filesystem.write"]
  if (kind === "execute") return ["process.execute"]
  if (kind === "network") return ["network.request"]
  if (kind === "delegate") return ["agent.delegate"]
  return ["session.update"]
}

export function capabilitiesForDefinition(tool: ToolDefinition): Capability[] {
  if (tool.metadata?.capabilities) return [...tool.metadata.capabilities]
  const capabilities = capabilitiesForKind(tool.kind)
  if (tool.metadata?.mutatesWorkspace && !capabilities.includes("filesystem.write")) {
    capabilities.push("filesystem.write")
  }
  return capabilities
}

export function normalizeIdentifier(value: string, label: string, maxLength = 32): string {
  const normalized = value.trim().toLowerCase()
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    normalized.includes("__") ||
    !/^[a-z][a-z0-9_-]*$/.test(normalized)
  ) {
    throw new Error(`Invalid ${label} "${value}"`)
  }
  return normalized
}

export function normalizeNamespace(value: string): string {
  const segments = value.split("__")
  if (segments.length > 3 || segments.some((segment) => segment.length === 0)) {
    throw new Error(`Invalid tool provider namespace "${value}"`)
  }
  return segments.map((segment) => normalizeIdentifier(segment, "tool provider namespace")).join("__")
}

function prepareTool(
  tool: ToolDefinition,
  registration: { providerId: string; provenance: ToolProvenance; namespace?: string },
): RegisteredTool {
  const publicName = normalizeIdentifier(tool.name, "tool name", 64)
  const qualifiedName = registration.namespace ? `${registration.namespace}__${publicName}` : publicName
  if (qualifiedName.length > 128) throw new Error(`Qualified tool name is too long: "${qualifiedName}"`)
  if (typeof tool.description !== "string" || tool.description.trim().length === 0 || tool.description.length > 4_096) {
    throw new Error(`Tool "${qualifiedName}" must have a bounded non-empty description`)
  }
  if (typeof tool.execute !== "function") throw new Error(`Tool "${qualifiedName}" must define execute()`)
  const capabilities = capabilitiesForDefinition(tool)
  for (const capability of capabilities) validateCapability(capability, qualifiedName)
  const validator = compileJsonSchema(tool.inputSchema)
  const definition: ToolDefinition = Object.freeze({
    ...tool,
    name: qualifiedName,
    metadata: Object.freeze({
      ...(tool.metadata ?? {}),
      capabilities: [...capabilities],
      providerId: registration.providerId,
      provenance: registration.provenance,
      tags: [...(tool.metadata?.tags ?? [])],
    }),
  })
  return {
    qualifiedName,
    publicName,
    providerId: registration.providerId,
    provenance: registration.provenance,
    definition,
    validator,
  }
}

function validateCapability(capability: Capability, toolName: string): void {
  const known = new Set<Capability>([
    "filesystem.read",
    "filesystem.write",
    "filesystem.external",
    "process.execute",
    "network.request",
    "agent.delegate",
    "session.update",
    "user.interact",
    "external.invoke",
  ])
  if (!known.has(capability)) throw new Error(`Tool "${toolName}" declares unknown capability "${capability}"`)
}
