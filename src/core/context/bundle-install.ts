import { constants } from "node:fs"
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { isInsidePath } from "../tools/builtins/path-utils.js"
import type { SkillImportCandidate, SkillImportResult } from "./skills-import.js"
import { importSkillsBundle, scanBundleSkills } from "./skills-import.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HookScript {
  name: string
  absPath: string
  event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop"
  matcher?: string
}

export interface BundleContents {
  bundleRootAbs: string
  bundleRootRel: string
  installRootAbs: string
  installRootRel: string
  name: string
  manifest: BundleManifest
  hasSkills: boolean
  hasHooks: boolean
  hasShared: boolean
  hasTools: boolean
  skillsDir?: string    // abs
  hooksDir?: string     // abs
  sharedDir?: string    // abs
  toolsDir?: string     // abs
  skillCandidates: SkillImportCandidate[]
  hookScripts: HookScript[]
  hooksDetected: number
  executableToolsDetected: number
  componentTargets: BundleComponentTarget[]
}

export interface BundleComponentTarget {
  name: "skills" | "hooks" | "shared" | "tools"
  sourcePath: string
  targetPath: string
}

export interface BundleInstallResult {
  skillsImported: number
  skillsSkipped: number
  skillsErrors: number
  skillResults: SkillImportResult[]
  hooksDetected: number
  executableToolsDetected: number
  inactiveComponents: Array<"hooks" | "tools">
  bundleResourcesCopied: boolean
  componentsCopied: string[]
  componentErrors: string[]
  dryRun: boolean
  bundleRecordPath?: string
  bundleRootPath: string
}

export interface BundleInstallOptions {
  dryRun?: boolean
  overwrite?: boolean
}

export interface InstalledBundle {
  name: string
  rootRel: string
  sourceRootRel?: string
  installedAt: string
  skillsImported: number
  hooksDetected: number
  executableToolsDetected: number
  inactiveComponents: Array<"hooks" | "tools">
  componentsCopied?: string[]
}

// ---------------------------------------------------------------------------
// bundle.json manifest (all fields optional)
// ---------------------------------------------------------------------------

export interface BundleManifest {
  name?: string
  description?: string
  /** Relative path within bundle root to the skills directory */
  skills?: string
  /** Relative path within bundle root to the hooks directory */
  hooks?: string
  /** Relative path within bundle root to the tools directory */
  tools?: string
  /** Relative path within bundle root to the shared/context directory */
  shared?: string
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Auto-detection candidates for each bundle component, tried in order */
const SKILLS_DIRS  = ["skills", "skill", "capabilities"]
const HOOKS_DIRS   = ["runtime-hooks", "hooks", ".hooks", "scripts/hooks"]
const TOOLS_DIRS   = ["tools", "scripts", "bin"]
const SHARED_DIRS  = ["shared", "context", "resources", "lib"]

export async function detectBundleRoots(cwd: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(cwd, { withFileTypes: true, encoding: "utf8" })
  } catch {
    return []
  }

  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const bundleRoot = path.join(cwd, entry.name)

    // Explicit manifest takes priority
    if (await fileExists(path.join(bundleRoot, "bundle.json"))) {
      found.push(entry.name)
      continue
    }

    // Heuristic: must have a skills dir AND at least one of hooks/tools/shared
    const hasSkills = await findSubdir(bundleRoot, SKILLS_DIRS) !== undefined
    if (!hasSkills) continue

    const hasHooks  = await findSubdir(bundleRoot, HOOKS_DIRS)  !== undefined
    const hasTools  = await findSubdir(bundleRoot, TOOLS_DIRS)  !== undefined
    const hasShared = await findSubdir(bundleRoot, SHARED_DIRS) !== undefined

    if (hasHooks || hasTools || hasShared) {
      found.push(entry.name)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export async function scanBundle(
  bundleRootAbs: string,
  targetSkillDirAbs: string,
  cwd: string,
): Promise<BundleContents> {
  if (!isInsidePath(cwd, bundleRootAbs)) {
    throw new Error(`Bundle root must be inside cwd: ${bundleRootAbs}`)
  }
  if (!isInsidePath(cwd, targetSkillDirAbs)) {
    throw new Error(`Target skill directory must be inside cwd: ${targetSkillDirAbs}`)
  }
  const [canonicalCwd, canonicalBundleRoot] = await Promise.all([realpath(cwd), realpath(bundleRootAbs)])
  if (!isInsidePath(canonicalCwd, canonicalBundleRoot)) {
    throw new Error(`Bundle root resolves outside cwd: ${bundleRootAbs}`)
  }
  bundleRootAbs = canonicalBundleRoot

  const manifest = await loadBundleManifest(bundleRootAbs)
  const bundleRootRel = path.relative(cwd, bundleRootAbs)
  const name = manifest.name ?? path.basename(bundleRootAbs)
  const installRootAbs = path.join(cwd, ".agents", "bundles", safeBundleName(name))
  const installRootRel = path.relative(cwd, installRootAbs)

  const skillsDirAbs  = await resolveComponent(bundleRootAbs, manifest.skills,  SKILLS_DIRS)
  const hooksDirAbs   = await resolveComponent(bundleRootAbs, manifest.hooks,   HOOKS_DIRS)
  const toolsDirAbs   = await resolveComponent(bundleRootAbs, manifest.tools,   TOOLS_DIRS)
  const sharedDirAbs  = await resolveComponent(bundleRootAbs, manifest.shared,  SHARED_DIRS)

  const skillCandidates = skillsDirAbs
    ? await scanBundleSkills(skillsDirAbs, targetSkillDirAbs, cwd)
    : []

  const hookScripts = hooksDirAbs
    ? await discoverHookScripts(hooksDirAbs)
    : []
  const hooksDetected = hooksDirAbs ? await countRegularFiles(hooksDirAbs) : 0
  const executableToolsDetected = toolsDirAbs ? await countRegularFiles(toolsDirAbs) : 0
  const componentTargets = bundleComponentTargets({
    bundleRootAbs,
    installRootAbs,
    skillsDirAbs,
    hooksDirAbs,
    sharedDirAbs,
    toolsDirAbs,
  })

  return {
    bundleRootAbs,
    bundleRootRel,
    installRootAbs,
    installRootRel,
    name,
    manifest,
    hasSkills:  skillsDirAbs !== undefined,
    hasHooks:   hooksDirAbs  !== undefined,
    hasShared:  sharedDirAbs !== undefined,
    hasTools:   toolsDirAbs  !== undefined,
    skillsDir:  skillsDirAbs,
    hooksDir:   hooksDirAbs,
    sharedDir:  sharedDirAbs,
    toolsDir:   toolsDirAbs,
    skillCandidates,
    hookScripts,
    hooksDetected,
    executableToolsDetected,
    componentTargets,
  }
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export async function installBundle(
  bundleRootAbs: string,
  targetSkillDirAbs: string,
  cwd: string,
  options: BundleInstallOptions = {},
): Promise<BundleInstallResult> {
  const contents = await scanBundle(bundleRootAbs, targetSkillDirAbs, cwd)
  if (!options.dryRun) {
    // Validate existing state before the first write so malformed JSON is never
    // replaced by a fresh registry after a partial installation.
    await listInstalledBundles(cwd)
  }

  const skillResults = contents.skillsDir
    ? await importSkillsBundle(contents.skillsDir, targetSkillDirAbs, cwd, {
        dryRun: options.dryRun,
        overwrite: options.overwrite,
      })
    : []
  const skillsImported = skillResults.filter((r) => r.status === "imported").length
  const skillsSkipped  = skillResults.filter((r) => r.status === "skipped").length
  const skillsErrors   = skillResults.filter((r) => r.status === "error").length

  const inactiveComponents: Array<"hooks" | "tools"> = [
    ...(contents.hasHooks ? ["hooks" as const] : []),
    ...(contents.hasTools ? ["tools" as const] : []),
  ]
  const componentInstall = options.dryRun
    ? { copied: [] as string[], errors: [] as string[] }
    : await installBundleComponents(contents, options.overwrite === true)
  const bundleRecordPath = options.dryRun
    ? undefined
    : await registerBundle(cwd, {
        name: contents.name,
        rootRel: contents.installRootRel,
        sourceRootRel: contents.bundleRootRel,
        installedAt: new Date().toISOString(),
        skillsImported,
        hooksDetected: contents.hooksDetected,
        executableToolsDetected: contents.executableToolsDetected,
        inactiveComponents,
        componentsCopied: componentInstall.copied,
      })

  return {
    skillsImported,
    skillsSkipped,
    skillsErrors,
    skillResults,
    hooksDetected: contents.hooksDetected,
    executableToolsDetected: contents.executableToolsDetected,
    inactiveComponents,
    bundleResourcesCopied: !options.dryRun && componentInstall.copied.length > 0,
    componentsCopied: componentInstall.copied,
    componentErrors: componentInstall.errors,
    dryRun: options.dryRun === true,
    bundleRecordPath,
    bundleRootPath: contents.installRootRel,
  }
}

async function installBundleComponents(
  contents: BundleContents,
  overwrite: boolean,
): Promise<{ copied: string[]; errors: string[] }> {
  const copied: string[] = []
  const errors: string[] = []

  await mkdir(contents.installRootAbs, { recursive: true })
  await copyBundleMetadata(contents.bundleRootAbs, contents.installRootAbs, overwrite)

  for (const component of contents.componentTargets) {
    try {
      await copyDirectorySafe(component.sourcePath, component.targetPath, overwrite)
      copied.push(component.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${component.name}: ${message}`)
    }
  }

  return { copied, errors }
}

async function copyBundleMetadata(sourceRoot: string, targetRoot: string, overwrite: boolean): Promise<void> {
  await mkdir(targetRoot, { recursive: true })
  for (const name of ["bundle.json", "README.md"]) {
    const source = path.join(sourceRoot, name)
    try {
      const sourceStat = await lstat(source)
      if (sourceStat.isSymbolicLink()) throw new Error(`Symbolic links are not supported in bundles: ${source}`)
      if (!sourceStat.isFile()) continue
      await copyFileSafe(source, path.join(targetRoot, name), overwrite)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
}

async function copyDirectorySafe(sourceDir: string, targetDir: string, overwrite: boolean): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true, encoding: "utf8" })
  await mkdir(targetDir, { recursive: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported in bundles: ${sourcePath}`)
    }
    if (entry.isDirectory()) {
      await copyDirectorySafe(sourcePath, targetPath, overwrite)
    } else if (entry.isFile()) {
      await copyFileSafe(sourcePath, targetPath, overwrite)
    }
  }
}

async function copyFileSafe(sourcePath: string, targetPath: string, overwrite: boolean): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true })
  if (overwrite) {
    await copyFile(sourcePath, targetPath)
    return
  }
  try {
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL)
  } catch (error) {
    if (!isFileExistsError(error)) throw error
  }
}

async function countRegularFiles(root: string): Promise<number> {
  let count = 0
  const entries = await readdir(root, { withFileTypes: true, encoding: "utf8" })
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported in bundles: ${entryPath}`)
    }
    if (entry.isDirectory()) count += await countRegularFiles(entryPath)
    else if (entry.isFile()) count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// Bundle registry -> .agents/bundles.json
// ---------------------------------------------------------------------------

async function registerBundle(cwd: string, record: InstalledBundle): Promise<string> {
  const dir      = path.join(cwd, ".agents")
  const filePath = path.join(dir, "bundles.json")

  const bundles = validateInstalledBundles(await readJsonIfExists<unknown>(filePath, []), filePath)

  const idx = bundles.findIndex((b) => b.name === record.name)
  if (idx >= 0) {
    bundles[idx] = record
  } else {
    bundles.push(record)
  }

  await mkdir(dir, { recursive: true })
  await writeFile(filePath, JSON.stringify(bundles, null, 2) + "\n", "utf8")
  return path.relative(cwd, filePath)
}

export async function listInstalledBundles(cwd: string): Promise<InstalledBundle[]> {
  const filePath = path.join(cwd, ".agents", "bundles.json")
  return validateInstalledBundles(await readJsonIfExists<unknown>(filePath, []), filePath)
}

// ---------------------------------------------------------------------------
// Hook discovery - parses shell script headers
// ---------------------------------------------------------------------------

const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"] as const
type HookEvent = (typeof HOOK_EVENTS)[number]

/**
 * Scan a hooks directory for shell scripts and parse their event type from
 * the header comment.  Expected format (first few lines of script):
 *   # <name> - <EventName> hook[ for <Matcher>].
 *
 * The matcher is a pipe-separated list of Claude Code tool names:
 *   "Edit|Write|Bash", "Agent", etc.
 */
async function discoverHookScripts(hooksDir: string): Promise<HookScript[]> {
  let entries
  try {
    entries = await readdir(hooksDir, { withFileTypes: true, encoding: "utf8" })
  } catch {
    return []
  }

  const scripts: HookScript[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sh")) continue
    const absPath = path.join(hooksDir, entry.name)
    try {
      // Read first 512 bytes - enough to cover the header comment
      const fd = await openFileHead(absPath, 512)
      const parsed = parseHookHeader(fd)
      if (parsed) {
        scripts.push({ name: entry.name, absPath, ...parsed })
      }
    } catch {
      // unreadable - skip
    }
  }
  return scripts
}

/** Read the first `maxBytes` bytes of a file as a UTF-8 string. */
async function openFileHead(filePath: string, maxBytes: number): Promise<string> {
  const buf = Buffer.alloc(maxBytes)
  const { open } = await import("node:fs/promises")
  const fh = await open(filePath, "r")
  try {
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
    return buf.subarray(0, bytesRead).toString("utf8")
  } finally {
    await fh.close()
  }
}

/**
 * Extract hook event and optional matcher from a script's header comment.
 * Handles both:
 *   "# scope_protect.sh - PreToolUse hook for Edit|Write|Bash."
 *   "# closeout_check.sh - Stop hook."
 *   "# agent_opus_check.sh - PreToolUse hook for Agent tool calls."
 */
function parseHookHeader(header: string): { event: HookEvent; matcher?: string } | undefined {
  // Find the event keyword
  const eventRe = new RegExp(`\\b(${HOOK_EVENTS.join("|")})\\b`)
  const eventMatch = eventRe.exec(header)
  if (!eventMatch) return undefined

  const event = eventMatch[1] as HookEvent

  // Extract matcher: "hook for <Word(|Word)*>" - stops at space+non-pipe-word, period, or newline
  const matcherRe = /hook\s+for\s+([A-Za-z]+(?:\|[A-Za-z]+)*)/
  const matcherMatch = matcherRe.exec(header)
  const matcher = matcherMatch ? matcherMatch[1] : undefined

  return { event, matcher }
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

async function loadBundleManifest(bundleRoot: string): Promise<BundleManifest> {
  const filePath = path.join(bundleRoot, "bundle.json")
  return validateBundleManifest(await readJsonIfExists<unknown>(filePath, {}), filePath)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a bundle component: use manifest value if set, else auto-detect. */
async function resolveComponent(
  bundleRoot: string,
  manifestValue: string | undefined,
  candidates: string[],
): Promise<string | undefined> {
  if (manifestValue) {
    const abs = path.resolve(bundleRoot, manifestValue)
    if (!isInsidePath(bundleRoot, abs)) {
      throw new Error(`Bundle component escapes bundle root: ${manifestValue}`)
    }
    if (!(await dirExists(abs))) {
      throw new Error(`Bundle component directory does not exist: ${manifestValue}`)
    }
    const [canonicalRoot, canonicalComponent] = await Promise.all([realpath(bundleRoot), realpath(abs)])
    if (!isInsidePath(canonicalRoot, canonicalComponent)) {
      throw new Error(`Bundle component resolves outside bundle root: ${manifestValue}`)
    }
    return canonicalComponent
  }
  return findSubdir(bundleRoot, candidates)
}

/** Return the absolute path of the first existing candidate subdir. */
async function findSubdir(base: string, candidates: string[]): Promise<string | undefined> {
  for (const name of candidates) {
    const abs = path.join(base, name)
    if (!(await dirExists(abs))) continue
    const [canonicalBase, canonicalCandidate] = await Promise.all([realpath(base), realpath(abs)])
    if (!isInsidePath(canonicalBase, canonicalCandidate)) {
      throw new Error(`Bundle component resolves outside bundle root: ${name}`)
    }
    return canonicalCandidate
  }
  return undefined
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function bundleComponentTargets(input: {
  bundleRootAbs: string
  installRootAbs: string
  skillsDirAbs?: string
  hooksDirAbs?: string
  sharedDirAbs?: string
  toolsDirAbs?: string
}): BundleComponentTarget[] {
  const components: Array<[BundleComponentTarget["name"], string | undefined]> = [
    ["skills", input.skillsDirAbs],
    ["hooks", input.hooksDirAbs],
    ["shared", input.sharedDirAbs],
    ["tools", input.toolsDirAbs],
  ]

  const targets: BundleComponentTarget[] = []
  for (const [name, sourcePath] of components) {
    if (!sourcePath) continue
    const rel = path.relative(input.bundleRootAbs, sourcePath)
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue
    targets.push({
      name,
      sourcePath,
      targetPath: path.join(input.installRootAbs, rel),
    })
  }
  return targets
}

function safeBundleName(name: string): string {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return safe || "bundle"
}

async function readJsonIfExists<T>(filePath: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return fallback
    }
    throw error
  }
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function validateBundleManifest(value: unknown, filePath: string): BundleManifest {
  if (!isRecord(value)) throw new Error(`Invalid bundle metadata in ${filePath}: expected an object`)
  const manifest: BundleManifest = {}
  for (const key of ["name", "description", "skills", "hooks", "tools", "shared"] as const) {
    const field = value[key]
    if (field !== undefined && (typeof field !== "string" || field.trim().length === 0)) {
      throw new Error(`Invalid bundle metadata in ${filePath}: "${key}" must be a non-empty string`)
    }
    if (typeof field === "string") manifest[key] = field
  }
  return manifest
}

function validateInstalledBundles(value: unknown, filePath: string): InstalledBundle[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid bundle registry in ${filePath}: expected an array`)
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid bundle registry in ${filePath}: entry ${index} must be an object`)
    }
    const name = requiredString(entry.name, filePath, index, "name")
    const rootRel = requiredString(entry.rootRel, filePath, index, "rootRel")
    const installedAt = requiredString(entry.installedAt, filePath, index, "installedAt")
    return {
      name,
      rootRel,
      sourceRootRel: optionalString(entry.sourceRootRel, filePath, index, "sourceRootRel"),
      installedAt,
      skillsImported: optionalNonNegativeInteger(entry.skillsImported, filePath, index, "skillsImported") ?? 0,
      hooksDetected: optionalNonNegativeInteger(entry.hooksDetected, filePath, index, "hooksDetected") ?? 0,
      executableToolsDetected:
        optionalNonNegativeInteger(entry.executableToolsDetected, filePath, index, "executableToolsDetected") ?? 0,
      inactiveComponents: optionalInactiveComponents(entry.inactiveComponents, filePath, index),
      componentsCopied:
        optionalStringArray(entry.componentsCopied, filePath, index, "componentsCopied") ??
        optionalStringArray(entry.componentsInstalled, filePath, index, "componentsInstalled"),
    }
  })
}

function requiredString(value: unknown, filePath: string, index: number, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid bundle registry in ${filePath}: entry ${index}.${key} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, filePath: string, index: number, key: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, filePath, index, key)
}

function optionalNonNegativeInteger(
  value: unknown,
  filePath: string,
  index: number,
  key: string,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid bundle registry in ${filePath}: entry ${index}.${key} must be a non-negative integer`)
  }
  return value
}

function optionalStringArray(
  value: unknown,
  filePath: string,
  index: number,
  key: string,
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid bundle registry in ${filePath}: entry ${index}.${key} must be a string array`)
  }
  return [...value]
}

function optionalInactiveComponents(
  value: unknown,
  filePath: string,
  index: number,
): Array<"hooks" | "tools"> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => item !== "hooks" && item !== "tools")) {
    throw new Error(
      `Invalid bundle registry in ${filePath}: entry ${index}.inactiveComponents must contain only hooks/tools`,
    )
  }
  return [...value] as Array<"hooks" | "tools">
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissingFileError(error: unknown): boolean {
  return isErrorCode(error, "ENOENT")
}

function isFileExistsError(error: unknown): boolean {
  return isErrorCode(error, "EEXIST")
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === code
}
