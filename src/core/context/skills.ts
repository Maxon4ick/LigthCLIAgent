import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { resolveInsideCwd } from "../tools/builtins/path-utils.js"

export interface SkillInfo {
  name: string
  path: string
  description?: string
  bodyPreview: string
}

const MAX_SKILLS = 20
const MAX_PREVIEW_CHARS = 4_000

export async function loadWorkspaceSkills(cwd: string, skillPaths: string[]): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []

  for (const configuredPath of skillPaths) {
    if (skills.length >= MAX_SKILLS) break
    const root = resolveInsideCwd(cwd, configuredPath)
    const rootSkills = await loadSkillsFromRoot(cwd, root)
    skills.push(...rootSkills.slice(0, MAX_SKILLS - skills.length))
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

async function loadSkillsFromRoot(cwd: string, root: string): Promise<SkillInfo[]> {
  let rootStat
  try {
    rootStat = await stat(root)
  } catch (error) {
    if (isMissingFileError(error)) {
      return []
    }
    throw error
  }

  if (!rootStat.isDirectory()) {
    return []
  }

  const entries = await readdir(root, { withFileTypes: true })
  const skillFiles = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "SKILL.md"))
  const rootSkill = path.join(root, "SKILL.md")
  const skills = await Promise.all([rootSkill, ...skillFiles].map((filePath) => loadSkillFile(cwd, filePath)))
  return skills.filter((skill): skill is SkillInfo => skill !== undefined)
}

async function loadSkillFile(cwd: string, filePath: string): Promise<SkillInfo | undefined> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }
    throw error
  }

  const relativePath = path.relative(cwd, filePath)
  const { frontmatter, body } = parseFrontmatter(raw)
  const name =
    frontmatter.name ??
    extractHeading(body) ??
    path.basename(path.dirname(filePath))
  return {
    name,
    path: relativePath,
    description: frontmatter.description ?? extractDescription(body),
    bodyPreview: raw.slice(0, MAX_PREVIEW_CHARS),
  }
}

interface Frontmatter {
  name?: string
  description?: string
}

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, body: raw }
  }

  const end = raw.indexOf("\n---", 3)
  if (end === -1) {
    return { frontmatter: {}, body: raw }
  }

  const block = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).trimStart()
  const frontmatter: Frontmatter = {}

  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "")
    if (key === "name" && value) frontmatter.name = value
    if (key === "description" && value) frontmatter.description = value
  }

  return { frontmatter, body }
}

function extractHeading(markdown: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(markdown)
  return match?.[1]?.trim()
}

function extractDescription(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }
    return trimmed.slice(0, 500)
  }
  return undefined
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  )
}
