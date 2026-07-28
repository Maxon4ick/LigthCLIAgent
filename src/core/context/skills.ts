import { readdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { AppConfig } from "../config/schema.js"
import type { EventBus } from "../events/event-bus.js"

export type SkillProvenance = "workspace" | "directory" | "bundle"

export interface SkillDescriptor {
  id: string
  name: string
  description?: string
  sourceId: string
  location: string
  provenance: SkillProvenance
}

export interface LoadedSkill extends SkillDescriptor {
  body: string
  resource?: string
}

export interface SkillSourceContext {
  cwd: string
  config: AppConfig
  events: EventBus
  abortSignal: AbortSignal
  resource?: string
}

export interface SkillSourceProvider {
  id: string
  priority?: number
  discover(context: SkillSourceContext): Promise<SkillDescriptor[]> | SkillDescriptor[]
  load(skill: SkillDescriptor, context: SkillSourceContext): Promise<LoadedSkill> | LoadedSkill
  dispose?(): Promise<void> | void
}

/** @deprecated Use DirectorySkillSource for directory-backed skills. */
export interface LegacySkillSource {
  id: string
  root: string
  priority?: number
  kind?: "workspace" | "bundle"
  dispose?(): Promise<void> | void
}

export type SkillSource = SkillSourceProvider | LegacySkillSource

/** Compatibility shape retained for existing list_skills and system-context consumers. */
export interface SkillInfo extends SkillDescriptor {
  path: string
  bodyPreview: string
  sourceKind: SkillProvenance
  absolutePath: string
}

export interface SkillDiagnostic {
  code: "duplicate" | "invalid" | "unreadable" | "missing_source" | "source_error"
  message: string
  path: string
  sourceId: string
  winnerPath?: string
  qualifiedIds?: string[]
}

export interface SkillIndex {
  skills: SkillInfo[]
  diagnostics: SkillDiagnostic[]
  sources: Map<string, SkillSourceProvider>
}

export interface DirectorySkillSourceOptions {
  id: string
  root: string
  priority?: number
  provenance?: SkillProvenance
  allowOutsideWorkspace?: boolean
}

export class DirectorySkillSource implements SkillSourceProvider {
  readonly id: string
  readonly priority?: number
  private readonly root: string
  private readonly provenance: SkillProvenance
  private readonly allowOutsideWorkspace: boolean

  constructor(options: DirectorySkillSourceOptions) {
    this.id = normalizeSourceId(options.id)
    this.root = options.root
    this.priority = options.priority
    this.provenance = options.provenance ?? "directory"
    this.allowOutsideWorkspace = options.allowOutsideWorkspace ?? false
  }

  async discover(context: SkillSourceContext): Promise<SkillDescriptor[]> {
    throwIfAborted(context.abortSignal)
    const root = await this.resolveRoot(context.cwd)
    const rootStat = await stat(root)
    if (!rootStat.isDirectory()) throw new Error(`Skill source is not a directory: ${this.root}`)
    const entries = await readdir(root, { withFileTypes: true })
    const candidates = [
      path.join(root, "SKILL.md"),
      ...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name, "SKILL.md")),
    ].sort()
    const skills: SkillDescriptor[] = []
    for (const candidate of candidates) {
      throwIfAborted(context.abortSignal)
      const descriptor = await this.inspectSkill(root, candidate)
      if (descriptor) skills.push(descriptor)
    }
    return skills
  }

  async load(skill: SkillDescriptor, context: SkillSourceContext): Promise<LoadedSkill> {
    if (skill.sourceId !== this.id) throw new Error(`Skill ${skill.id} does not belong to source ${this.id}`)
    throwIfAborted(context.abortSignal)
    const root = await this.resolveRoot(context.cwd)
    const skillFile = await canonicalInside(root, skill.location)
    const skillDirectory = path.dirname(skillFile)
    const target = context.resource
      ? await resolveResource(skillDirectory, context.resource)
      : skillFile
    return {
      ...skill,
      body: await readFile(target, "utf8"),
      resource: context.resource,
    }
  }

  private async resolveRoot(cwd: string): Promise<string> {
    const resolved = path.resolve(cwd, this.root)
    if (!this.allowOutsideWorkspace) {
      const relative = path.relative(path.resolve(cwd), resolved)
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Skill source escapes workspace: ${this.root}`)
      }
    }
    return realpath(resolved)
  }

  private async inspectSkill(root: string, candidate: string): Promise<SkillDescriptor | undefined> {
    let canonical: string
    try {
      canonical = await canonicalInside(root, candidate)
    } catch (error) {
      if (isMissingFileError(error)) return undefined
      throw error
    }
    const raw = await readFile(canonical, "utf8")
    if (!raw.trim()) throw new Error(`SKILL.md is empty: ${candidate}`)
    const { frontmatter, body } = parseFrontmatter(raw)
    const name = (frontmatter.name ?? extractHeading(body) ?? path.basename(path.dirname(canonical))).trim()
    if (!name) throw new Error(`SKILL.md does not define a usable name: ${candidate}`)
    return {
      id: `${this.id}:${normalizeSkillName(name)}`,
      name,
      description: frontmatter.description ?? extractDescription(body),
      sourceId: this.id,
      location: canonical,
      provenance: this.provenance,
    }
  }
}

export function workspaceSkillSources(skillPaths: readonly string[]): SkillSource[] {
  return skillPaths.map((root, index) => new DirectorySkillSource({
    id: index === 0 ? "workspace" : `workspace_${index}`,
    root,
    priority: skillPaths.length - index,
    provenance: "workspace",
  }))
}

export async function loadSkillIndex(
  cwd: string,
  sources: readonly SkillSource[],
  baseContext?: Partial<Omit<SkillSourceContext, "cwd">>,
): Promise<SkillIndex> {
  const diagnostics: SkillDiagnostic[] = []
  const sourceMap = new Map<string, SkillSourceProvider>()
  const legacySourceIds = new Set<string>()
  const candidates: Array<SkillInfo & { priority: number; sourceOrder: number }> = []
  const config = baseContext?.config ?? (await import("../config/schema.js")).defaultConfig
  const events = baseContext?.events ?? new (await import("../events/event-bus.js")).EventBus()
  const abortSignal = baseContext?.abortSignal ?? new AbortController().signal

  for (const [sourceOrder, configuredSource] of sources.entries()) {
    const source = asSkillSource(configuredSource)
    const sourceId = normalizeSourceId(source.id)
    if ("root" in configuredSource) legacySourceIds.add(sourceId)
    if (sourceMap.has(sourceId)) {
      diagnostics.push({
        code: "invalid",
        message: `Duplicate skill source id "${sourceId}"`,
        path: "",
        sourceId,
      })
      continue
    }
    sourceMap.set(sourceId, source)
    const started = Date.now()
    try {
      const descriptors = await source.discover({ cwd, config, events, abortSignal })
      for (const descriptor of descriptors) {
        if (descriptor.sourceId !== sourceId) {
          throw new Error(`Source "${sourceId}" returned descriptor for "${descriptor.sourceId}"`)
        }
        candidates.push({
          ...descriptor,
          id: descriptor.id || `${sourceId}:${normalizeSkillName(descriptor.name)}`,
          path: displayPath(cwd, descriptor.location),
          bodyPreview: "",
          sourceKind: descriptor.provenance,
          absolutePath: path.resolve(descriptor.location),
          priority: source.priority ?? 0,
          sourceOrder,
        })
      }
      events.publish({
        type: "skill.source.loaded",
        payload: {
          extensionId: sourceId,
          provenance: descriptors[0]?.provenance ?? "directory",
          durationMs: Date.now() - started,
        },
      })
    } catch (error) {
      diagnostics.push({
        code: isMissingFileError(error) ? "missing_source" : "source_error",
        message: safeError(error),
        path: "",
        sourceId,
      })
    }
  }

  candidates.sort((left, right) =>
    right.priority - left.priority ||
    left.sourceOrder - right.sourceOrder ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id),
  )
  const byName = new Map<string, SkillInfo[]>()
  for (const candidate of candidates) {
    const { priority: _priority, sourceOrder: _sourceOrder, ...skill } = candidate
    const key = skill.name.toLocaleLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), skill])
  }
  const selected: SkillInfo[] = []
  for (const duplicates of byName.values()) {
    if (duplicates.length < 2) {
      selected.push(...duplicates)
      continue
    }
    const legacy = duplicates.some((skill) => legacySourceIds.has(skill.sourceId))
    const reported = legacy ? duplicates.slice(1) : duplicates
    if (legacy) selected.push(duplicates[0] as SkillInfo)
    else selected.push(...duplicates)
    for (const skill of reported) {
      diagnostics.push({
        code: "duplicate",
        message: legacy
          ? `Duplicate skill "${skill.name}" ignored; "${duplicates[0]?.path}" has higher source priority`
          : `Skill "${skill.name}" is ambiguous; use a qualified id`,
        path: skill.path,
        sourceId: skill.sourceId,
        winnerPath: legacy ? duplicates[0]?.path : undefined,
        qualifiedIds: duplicates.map((item) => item.id),
      })
    }
  }
  return {
    skills: selected,
    diagnostics,
    sources: sourceMap,
  }
}

export async function loadWorkspaceSkills(cwd: string, skillPaths: string[]): Promise<SkillInfo[]> {
  return (await loadSkillIndex(cwd, workspaceSkillSources(skillPaths))).skills
}

export function resolveSkill(index: SkillIndex, requested: string): SkillInfo {
  const exact = index.skills.find((skill) => skill.id.toLowerCase() === requested.toLowerCase())
  if (exact) return exact
  const matches = index.skills.filter((skill) =>
    skill.name.toLowerCase() === requested.toLowerCase() ||
    skill.path.toLowerCase() === requested.toLowerCase(),
  )
  if (matches.length === 0) throw new Error(`Skill not found: ${requested}`)
  if (matches.length > 1) {
    throw new Error(`Skill "${requested}" is ambiguous; use one of: ${matches.map((skill) => skill.id).join(", ")}`)
  }
  return matches[0] as SkillInfo
}

export async function loadIndexedSkill(
  index: SkillIndex,
  skill: SkillDescriptor,
  context: SkillSourceContext,
): Promise<LoadedSkill> {
  const source = index.sources.get(skill.sourceId)
  if (!source) throw new Error(`Skill source is unavailable: ${skill.sourceId}`)
  return source.load(skill, context)
}

function asSkillSource(source: SkillSource): SkillSourceProvider {
  if ("discover" in source) return source
  return new DirectorySkillSource({
    id: source.id,
    root: source.root,
    priority: source.priority,
    provenance: source.kind ?? "workspace",
  })
}

async function canonicalInside(root: string, candidate: string): Promise<string> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([realpath(root), realpath(candidate)])
  const relative = path.relative(canonicalRoot, canonicalCandidate)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Skill path resolves outside its configured source")
  }
  return canonicalCandidate
}

async function resolveResource(skillDirectory: string, resource: string): Promise<string> {
  if (path.isAbsolute(resource)) throw new Error("Skill resource must be relative")
  const resolved = path.resolve(skillDirectory, resource)
  return canonicalInside(skillDirectory, resolved)
}

function displayPath(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : path.resolve(filePath)
}

function normalizeSourceId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_")
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)) throw new Error(`Invalid skill source id "${value}"`)
  return normalized
}

function normalizeSkillName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!normalized || normalized.length > 80) throw new Error(`Invalid skill name "${value}"`)
  return normalized
}

interface Frontmatter {
  name?: string
  description?: string
}

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw }
  const end = raw.indexOf("\n---", 3)
  if (end === -1) return { frontmatter: {}, body: raw }
  const block = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).trimStart()
  const frontmatter: Frontmatter = {}
  let multiline: "description" | undefined
  const description: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (multiline && /^\s+/.test(line)) {
      description.push(line.trim())
      continue
    }
    if (multiline) {
      frontmatter.description = description.join(" ")
      multiline = undefined
    }
    const separator = line.indexOf(":")
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key === "name" && value) frontmatter.name = stripQuotes(value)
    if (key === "description") {
      if ([">-", ">", "|", "|-"].includes(value)) multiline = "description"
      else if (value) frontmatter.description = stripQuotes(value)
    }
  }
  if (multiline) frontmatter.description = description.join(" ")
  return { frontmatter, body }
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "")
}

function extractHeading(markdown: string): string | undefined {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim()
}

function extractDescription(markdown: string): string | undefined {
  return markdown.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"))?.slice(0, 500)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Skill operation aborted")
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}
