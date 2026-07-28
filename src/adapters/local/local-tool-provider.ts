import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Capability } from "../../core/permissions/policy.js"
import { redactSecrets } from "../../core/security/redaction.js"
import { compileJsonSchema, validateCompiledJsonSchema } from "../../core/tools/json-schema.js"
import { normalizeIdentifier } from "../../core/tools/registry.js"
import type {
  ToolContext,
  ToolDefinition,
  ToolProvider,
  ToolProviderContext,
  ToolResult,
} from "../../core/tools/tool.js"

const MAX_MANIFEST_BYTES = 256 * 1024

export interface LocalToolManifestTool {
  export: string
  name: string
  description: string
  capabilities: Capability[]
  inputSchema: unknown
  kind?: ToolDefinition["kind"]
}

export interface LocalToolManifest {
  version: 1
  id: string
  entry: string
  tools: LocalToolManifestTool[]
}

export interface InspectedLocalToolManifest {
  manifest: LocalToolManifest
  manifestPath: string
  extensionRoot: string
  entryPath: string
}

export interface LocalToolProviderOptions {
  manifestPath: string
  extensionRoot?: string
  trusted: boolean
}

export async function inspectLocalToolManifest(
  manifestPath: string,
  extensionRoot = path.dirname(path.resolve(manifestPath)),
): Promise<InspectedLocalToolManifest> {
  const manifestStats = await stat(manifestPath)
  if (manifestStats.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Local tool manifest exceeds ${MAX_MANIFEST_BYTES} bytes`)
  }
  const [canonicalRoot, canonicalManifest] = await Promise.all([
    realpath(extensionRoot),
    realpath(manifestPath),
  ])
  assertInside(canonicalRoot, canonicalManifest, "manifest")
  const raw = await readFile(canonicalManifest, "utf8")
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("Local tool manifest must contain valid JSON")
  }
  const validator = compileJsonSchema(localManifestSchema)
  const validation = validateCompiledJsonSchema(validator, value, {
    maxBytes: MAX_MANIFEST_BYTES,
    maxDepth: 32,
    maxNodes: 10_000,
  })
  if (!validation.valid) throw new Error(`Invalid local tool manifest: ${validation.errors.join("; ")}`)
  const manifest = value as LocalToolManifest
  manifest.id = normalizeIdentifier(manifest.id, "local extension id")
  if (path.isAbsolute(manifest.entry)) throw new Error("Local tool manifest entry must be relative")
  const resolvedEntry = path.resolve(path.dirname(canonicalManifest), manifest.entry)
  const canonicalEntry = await realpath(resolvedEntry)
  assertInside(canonicalRoot, canonicalEntry, "entry")
  const names = new Set<string>()
  for (const tool of manifest.tools) {
    tool.name = normalizeIdentifier(tool.name, "local tool name", 64)
    if (names.has(tool.name)) throw new Error(`Duplicate local tool name "${tool.name}"`)
    names.add(tool.name)
    normalizeIdentifier(tool.export, "local tool export", 64)
    compileJsonSchema(tool.inputSchema)
  }
  return {
    manifest,
    manifestPath: canonicalManifest,
    extensionRoot: canonicalRoot,
    entryPath: canonicalEntry,
  }
}

export async function createLocalToolProvider(options: LocalToolProviderOptions): Promise<LocalToolProvider> {
  const inspected = await inspectLocalToolManifest(options.manifestPath, options.extensionRoot)
  return new LocalToolProvider(inspected, options.trusted)
}

export class LocalToolProvider implements ToolProvider {
  readonly id: string
  readonly provenance = "local" as const
  readonly requiresExplicitCapabilities = true
  readonly namespace: string
  private moduleDispose?: () => Promise<void> | void
  private disposed = false

  constructor(
    readonly inspected: InspectedLocalToolManifest,
    readonly trusted: boolean,
  ) {
    this.id = inspected.manifest.id
    this.namespace = `local__${this.id}`
  }

  async load(context: ToolProviderContext): Promise<ToolDefinition[]> {
    if (!this.trusted) {
      throw new Error(
        `Local extension "${this.id}" is executable Node.js code and requires explicit trust`,
      )
    }
    throwIfAborted(context.abortSignal)
    let module: Record<string, unknown>
    try {
      module = await import(pathToFileURL(this.inspected.entryPath).href)
    } catch (error) {
      throw new Error(`Failed to import local extension "${this.id}": ${redactSecrets(safeError(error))}`)
    }
    throwIfAborted(context.abortSignal)
    const definitions: ToolDefinition[] = []
    for (const manifestTool of this.inspected.manifest.tools) {
      const exported = module[manifestTool.export]
      definitions.push(toolFromExport(manifestTool, exported))
    }
    if (typeof module.dispose === "function") {
      this.moduleDispose = module.dispose as () => Promise<void> | void
    }
    return definitions
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.moduleDispose?.()
  }
}

function toolFromExport(manifest: LocalToolManifestTool, exported: unknown): ToolDefinition {
  const execute = typeof exported === "function"
    ? exported as (input: unknown, context: ToolContext) => Promise<ToolResult> | ToolResult
    : isRecord(exported) && typeof exported.execute === "function"
      ? exported.execute as (input: unknown, context: ToolContext) => Promise<ToolResult> | ToolResult
      : undefined
  if (!execute) throw new Error(`Unknown or invalid export "${manifest.export}" for tool "${manifest.name}"`)
  return {
    name: manifest.name,
    description: manifest.description,
    inputSchema: manifest.inputSchema,
    kind: manifest.kind ?? "other",
    metadata: {
      capabilities: [...manifest.capabilities],
      safeConcurrent: false,
      mutatesWorkspace: manifest.capabilities.includes("filesystem.write"),
      requiresApproval: true,
      tags: ["local-extension"],
    },
    execute: async (input, context) => execute(input, context),
  }
}

function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Local extension ${label} resolves outside the configured extension root`)
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Local extension loading aborted")
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const localManifestSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["version", "id", "entry", "tools"],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    id: { type: "string", minLength: 1, maxLength: 64 },
    entry: { type: "string", minLength: 1, maxLength: 1_024 },
    tools: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: {
        type: "object",
        required: ["export", "name", "description", "capabilities", "inputSchema"],
        additionalProperties: false,
        properties: {
          export: { type: "string", minLength: 1, maxLength: 64 },
          name: { type: "string", minLength: 1, maxLength: 64 },
          description: { type: "string", minLength: 1, maxLength: 4_096 },
          capabilities: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: {
              enum: [
                "filesystem.read",
                "filesystem.write",
                "filesystem.external",
                "process.execute",
                "network.request",
                "agent.delegate",
                "session.update",
                "user.interact",
                "external.invoke",
              ],
            },
          },
          inputSchema: { type: "object" },
          kind: {
            enum: ["read", "search", "execute", "edit", "network", "delegate", "other"],
          },
        },
      },
    },
  },
} as const
