import { constants } from "node:fs"
import { copyFile, lstat, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { isInsidePath } from "../tools/builtins/path-utils.js"

export interface SkillImportCandidate {
  name: string
  description?: string
  sourcePath: string  // relative to cwd
  targetPath: string  // relative to cwd
  sourceDir: string   // relative to cwd
  targetDir: string   // relative to cwd
  exists: boolean     // target SKILL.md already present
  rootSkill: boolean  // true when the source is bundleDir/SKILL.md
}

export interface SkillImportResult {
  name: string
  status: "imported" | "skipped" | "error"
  targetPath: string  // relative to cwd
  error?: string
}

export interface SkillImportOptions {
  dryRun?: boolean
  overwrite?: boolean
}

/**
 * Scan `bundleDir` for skill subdirectories (each containing a SKILL.md)
 * plus an optional root-level SKILL.md, and report which ones already exist
 * at `targetDir`.
 */
export async function scanBundleSkills(
  bundleDir: string,
  targetDir: string,
  cwd: string,
): Promise<SkillImportCandidate[]> {
  await assertSafeSourceRoot(bundleDir, cwd)
  assertInsideCwd(targetDir, cwd, "Target skill directory")
  let entries
  try {
    entries = await readdir(bundleDir, { withFileTypes: true, encoding: "utf8" })
  } catch {
    return []
  }

  const candidates: SkillImportCandidate[] = []

  const rootCandidate = await readSkillCandidate({
    sourceDir: bundleDir,
    targetDir,
    sourceFile: path.join(bundleDir, "SKILL.md"),
    targetFile: path.join(targetDir, "SKILL.md"),
    fallbackName: path.basename(bundleDir),
    cwd,
    rootSkill: true,
  })
  if (rootCandidate) candidates.push(rootCandidate)

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported in skill bundles: ${path.join(bundleDir, entry.name)}`)
    }
    if (!entry.isDirectory()) continue

    const sourceDir = path.join(bundleDir, entry.name)
    const targetSkillDir = path.join(targetDir, entry.name)
    const sourceFile = path.join(bundleDir, entry.name, "SKILL.md")
    const targetFile = path.join(targetSkillDir, "SKILL.md")

    const candidate = await readSkillCandidate({
      sourceDir,
      targetDir: targetSkillDir,
      sourceFile,
      targetFile,
      fallbackName: entry.name,
      cwd,
      rootSkill: false,
    })
    if (candidate) candidates.push(candidate)
  }

  return candidates.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Copy all skills from `bundleDir` into `targetDir`.
 * Files that already exist at the target are skipped.
 * Directory-based skills are copied as whole directories so bundled
 * references/scripts/assets stay available next to the SKILL.md.
 */
export async function importSkillsBundle(
  bundleDir: string,
  targetDir: string,
  cwd: string,
  options: SkillImportOptions = {},
): Promise<SkillImportResult[]> {
  const candidates = await scanBundleSkills(bundleDir, targetDir, cwd)
  const results: SkillImportResult[] = []

  for (const candidate of candidates) {
    if (candidate.exists) {
      try {
        if (options.dryRun) {
          results.push({ name: candidate.name, status: "skipped", targetPath: candidate.targetPath })
          continue
        }
        if (candidate.rootSkill && options.overwrite) {
          await copyFile(
            path.resolve(cwd, candidate.sourcePath),
            path.resolve(cwd, candidate.targetPath),
          )
        } else if (!candidate.rootSkill) {
          await copyDirectory(
            path.resolve(cwd, candidate.sourceDir),
            path.resolve(cwd, candidate.targetDir),
            options.overwrite
              ? { existing: "overwrite" }
              : { existing: "skip", skipRootSkillFile: true },
          )
        }
        results.push({ name: candidate.name, status: "skipped", targetPath: candidate.targetPath })
      } catch (error) {
        results.push({
          name: candidate.name,
          status: "error",
          targetPath: candidate.targetPath,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      continue
    }

    const sourceFile = path.resolve(cwd, candidate.sourcePath)
    const sourceDir = path.resolve(cwd, candidate.sourceDir)
    const targetFile = path.resolve(cwd, candidate.targetPath)
    const targetSkillDir = path.resolve(cwd, candidate.targetDir)

    try {
      if (options.dryRun) {
        results.push({ name: candidate.name, status: "imported", targetPath: candidate.targetPath })
        continue
      }
      if (candidate.rootSkill) {
        await mkdir(targetSkillDir, { recursive: true })
        await copyFile(sourceFile, targetFile, constants.COPYFILE_EXCL)
      } else {
        await copyDirectory(sourceDir, targetSkillDir, { existing: "error" })
      }
      results.push({ name: candidate.name, status: "imported", targetPath: candidate.targetPath })
    } catch (error) {
      results.push({
        name: candidate.name,
        status: "error",
        targetPath: candidate.targetPath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return results
}

/**
 * Scan `cwd` one level deep for directories that look like skill bundles:
 * `<something>/skills/` containing at least one subdirectory with a SKILL.md.
 * Returns relative paths (e.g. "ascend310p-operator-porting/skills").
 */
export async function detectBundlePaths(cwd: string): Promise<string[]> {
  let topLevel
  try {
    topLevel = await readdir(cwd, { withFileTypes: true, encoding: "utf8" })
  } catch {
    return []
  }

  const found: string[] = []

  for (const entry of topLevel) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith(".")) continue

    const skillsDir = path.join(cwd, entry.name, "skills")
    try {
      const skillsStat = await stat(skillsDir)
      if (!skillsStat.isDirectory()) continue
    } catch {
      continue
    }

    let inner
    try {
      inner = await readdir(skillsDir, { withFileTypes: true, encoding: "utf8" })
    } catch {
      continue
    }

    if (await fileExists(path.join(skillsDir, "SKILL.md"))) {
      found.push(path.join(entry.name, "skills"))
      continue
    }

    for (const sub of inner) {
      if (!sub.isDirectory()) continue
      try {
        await stat(path.join(skillsDir, sub.name, "SKILL.md"))
        found.push(path.join(entry.name, "skills"))
        break
      } catch {
        // keep looking
      }
    }
  }

  return found
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function readSkillCandidate(input: {
  sourceDir: string
  targetDir: string
  sourceFile: string
  targetFile: string
  fallbackName: string
  cwd: string
  rootSkill: boolean
}): Promise<SkillImportCandidate | undefined> {
  try {
    const sourceStat = await lstat(input.sourceFile)
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported in skill bundles: ${input.sourceFile}`)
    }
    if (!sourceStat.isFile()) return undefined
  } catch (error) {
    if (isMissingFileError(error)) return undefined
    throw error
  }

  let raw: string
  try {
    raw = await readFile(input.sourceFile, "utf8")
  } catch (error) {
    if (isMissingFileError(error)) return undefined
    throw error
  }

  const { frontmatter, body } = parseFrontmatter(raw)
  const name = frontmatter.name ?? extractHeading(body) ?? input.fallbackName
  const description = frontmatter.description

  let exists = false
  try {
    await stat(input.targetFile)
    exists = true
  } catch {
    // doesn't exist yet
  }

  return {
    name,
    description,
    sourcePath: path.relative(input.cwd, input.sourceFile),
    targetPath: path.relative(input.cwd, input.targetFile),
    sourceDir: path.relative(input.cwd, input.sourceDir),
    targetDir: path.relative(input.cwd, input.targetDir),
    exists,
    rootSkill: input.rootSkill,
  }
}

async function copyDirectory(
  sourceDir: string,
  targetDir: string,
  options: { existing: "error" | "skip" | "overwrite"; skipRootSkillFile?: boolean },
  rootDir = sourceDir,
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true, encoding: "utf8" })

  await mkdir(targetDir, { recursive: true })

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath, options, rootDir)
      continue
    }

    if (entry.isFile()) {
      if (options.skipRootSkillFile && path.resolve(sourcePath) === path.resolve(rootDir, "SKILL.md")) {
        continue
      }
      await copyFileOrSkip(sourcePath, targetPath, options.existing)
      continue
    }

    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported in skill bundles: ${sourcePath}`)
    }
  }
}

async function copyFileOrSkip(
  sourcePath: string,
  targetPath: string,
  existing: "error" | "skip" | "overwrite",
): Promise<void> {
  if (existing === "overwrite") {
    await copyFile(sourcePath, targetPath)
    return
  }
  try {
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL)
  } catch (error) {
    if (existing === "skip" && isFileExistsError(error)) return
    throw error
  }
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

  let inDescription = false
  const descLines: string[] = []

  for (const line of block.split(/\r?\n/)) {
    if (inDescription) {
      if (/^\s+/.test(line)) {
        descLines.push(line.trim())
        continue
      }
      inDescription = false
      frontmatter.description = descLines.join(" ")
    }

    const colon = line.indexOf(":")
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()

    if (key === "name" && value) {
      frontmatter.name = value.replace(/^["']|["']$/g, "")
    }

    if (key === "description") {
      if (value === ">-" || value === ">" || value === "|" || value === "|-") {
        inDescription = true
        descLines.length = 0
      } else if (value) {
        frontmatter.description = value.replace(/^["']|["']$/g, "")
      }
    }
  }

  if (inDescription && descLines.length > 0) {
    frontmatter.description = descLines.join(" ")
  }

  return { frontmatter, body }
}

function extractHeading(markdown: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(markdown)
  return match?.[1]?.trim()
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  )
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  )
}

async function assertSafeSourceRoot(sourceRoot: string, cwd: string): Promise<void> {
  assertInsideCwd(sourceRoot, cwd, "Skill bundle")
  const [canonicalCwd, canonicalSource] = await Promise.all([realpath(cwd), realpath(sourceRoot)])
  if (!isInsidePath(canonicalCwd, canonicalSource)) {
    throw new Error(`Skill bundle resolves outside cwd: ${sourceRoot}`)
  }
}

function assertInsideCwd(target: string, cwd: string, label: string): void {
  if (!isInsidePath(cwd, target)) {
    throw new Error(`${label} must be inside cwd: ${target}`)
  }
}
