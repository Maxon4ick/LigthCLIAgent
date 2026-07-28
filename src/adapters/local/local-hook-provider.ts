import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { AgentHook, HookProvider } from "../../core/hooks/hooks.js"
import { compileJsonSchema, validateCompiledJsonSchema } from "../../core/tools/json-schema.js"
import { normalizeIdentifier } from "../../core/tools/registry.js"

const MAX_MANIFEST_BYTES = 256 * 1024

export interface LocalHookManifest {
  version: 1
  id: string
  entry: string
  hooks: Array<{ export: string; id: string; priority?: number }>
}

export interface LocalHookProviderOptions {
  manifestPath: string
  extensionRoot?: string
  trusted: boolean
}

export class LocalHookProvider implements HookProvider {
  readonly id: string
  private disposed = false
  private moduleDispose?: () => Promise<void> | void

  private constructor(
    private readonly manifest: LocalHookManifest,
    private readonly entryPath: string,
    private readonly trusted: boolean,
  ) {
    this.id = manifest.id
  }

  static async create(options: LocalHookProviderOptions): Promise<LocalHookProvider> {
    const manifestPath = path.resolve(options.manifestPath)
    const extensionRoot = path.resolve(options.extensionRoot ?? path.dirname(manifestPath))
    const stats = await stat(manifestPath)
    if (stats.size > MAX_MANIFEST_BYTES) throw new Error("Local hook manifest is too large")
    const [root, canonicalManifest] = await Promise.all([realpath(extensionRoot), realpath(manifestPath)])
    assertInside(root, canonicalManifest)
    let value: unknown
    try {
      value = JSON.parse(await readFile(canonicalManifest, "utf8"))
    } catch {
      throw new Error("Local hook manifest must contain valid JSON")
    }
    const validation = validateCompiledJsonSchema(compileJsonSchema(schema), value)
    if (!validation.valid) throw new Error(`Invalid local hook manifest: ${validation.errors.join("; ")}`)
    const manifest = value as LocalHookManifest
    manifest.id = normalizeIdentifier(manifest.id, "local hook provider id")
    if (path.isAbsolute(manifest.entry)) throw new Error("Local hook entry must be relative")
    const entryPath = await realpath(path.resolve(path.dirname(canonicalManifest), manifest.entry))
    assertInside(root, entryPath)
    const ids = new Set<string>()
    for (const hook of manifest.hooks) {
      hook.id = normalizeIdentifier(hook.id, "local hook id", 64)
      normalizeIdentifier(hook.export, "local hook export", 64)
      if (ids.has(hook.id)) throw new Error(`Duplicate local hook id "${hook.id}"`)
      ids.add(hook.id)
    }
    return new LocalHookProvider(manifest, entryPath, options.trusted)
  }

  async load(): Promise<AgentHook[]> {
    if (!this.trusted) throw new Error(`Local hooks "${this.id}" require explicit trust`)
    const module = await import(pathToFileURL(this.entryPath).href) as Record<string, unknown>
    const hooks = this.manifest.hooks.map((item) => {
      const exported = module[item.export]
      if (!isRecord(exported)) throw new Error(`Unknown or invalid hook export "${item.export}"`)
      return {
        ...(exported as unknown as AgentHook),
        id: item.id,
        priority: item.priority,
        provenance: "local" as const,
      }
    })
    if (typeof module.dispose === "function") this.moduleDispose = module.dispose as () => Promise<void> | void
    return hooks
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.moduleDispose?.()
  }
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Local hook path resolves outside the extension root")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const schema = {
  type: "object",
  required: ["version", "id", "entry", "hooks"],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    id: { type: "string", minLength: 1, maxLength: 64 },
    entry: { type: "string", minLength: 1, maxLength: 1_024 },
    hooks: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: {
        type: "object",
        required: ["export", "id"],
        additionalProperties: false,
        properties: {
          export: { type: "string", minLength: 1, maxLength: 64 },
          id: { type: "string", minLength: 1, maxLength: 64 },
          priority: { type: "integer" },
        },
      },
    },
  },
} as const
