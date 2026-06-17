import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { ExternalDirectoryError, isProtectedPath, resolveRealInsideCwd } from "./path-utils.js"
import type { ToolContext, ToolDefinition } from "../tool.js"

interface GrepInput {
  pattern: string
  path?: string
  caseSensitive?: boolean
}

interface GrepMatch {
  path: string
  line: number
  text: string
}

interface GrepOutput {
  pattern: string
  matches: GrepMatch[]
  truncated: boolean
}

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"])
const MAX_MATCHES = 50

export const grepTool: ToolDefinition<unknown, GrepOutput> = {
  name: "grep",
  description: "Search for a literal string in one file or recursively inside the workspace.",
  kind: "search",
  metadata: {
    safeConcurrent: true,
    mutatesWorkspace: false,
    requiresApproval: false,
    tags: ["files", "search"],
  },
  inputSchema: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      caseSensitive: { type: "boolean" },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    const start = parsed.path ? await resolveSearchStart(context, parsed.path) : context.cwd
    const startStat = await stat(start)
    const files = startStat.isDirectory() ? await listFiles(start, context.cwd) : [start]
    const matches: GrepMatch[] = []

    for (const file of files) {
      if (matches.length >= MAX_MATCHES) break
      await searchFile(file, context.cwd, parsed, matches)
    }

    return {
      ok: true,
      output: {
        pattern: parsed.pattern,
        matches,
        truncated: matches.length >= MAX_MATCHES,
      },
    }
  },
}

function parseInput(input: unknown): GrepInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("grep input must be an object")
  }

  const record = input as Record<string, unknown>
  if (typeof record.pattern !== "string" || record.pattern.length === 0) {
    throw new Error("grep.pattern must be a non-empty string")
  }

  if (record.path !== undefined && typeof record.path !== "string") {
    throw new Error("grep.path must be a string")
  }

  if (record.caseSensitive !== undefined && typeof record.caseSensitive !== "boolean") {
    throw new Error("grep.caseSensitive must be a boolean")
  }

  return {
    pattern: record.pattern,
    path: record.path,
    caseSensitive: record.caseSensitive,
  }
}

async function resolveSearchStart(context: ToolContext, requestedPath: string): Promise<string> {
  try {
    return await resolveRealInsideCwd(context.cwd, requestedPath)
  } catch (error) {
    if (!(error instanceof ExternalDirectoryError)) {
      throw error
    }

    const decision = await context.permissionPolicy.decide({
      sessionId: context.sessionId,
      agentId: context.agentId,
      action: "external_directory",
      resources: [error.realPath],
      source: {
        type: "tool",
        toolCallId: context.toolCallId,
        messageId: context.assistantMessageId,
      },
    })

    if (decision !== "allow") {
      throw new Error(`External directory access denied by permission policy: ${decision}`)
    }

    return error.realPath
  }
}

async function listFiles(directory: string, cwd: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".agent") {
      continue
    }

    const fullPath = path.join(directory, entry.name)
    if (isProtectedPath(cwd, fullPath)) {
      continue
    }

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...(await listFiles(fullPath, cwd)))
      }
    } else if (entry.isSymbolicLink()) {
      const realPath = await resolveSymlinkForSearch(cwd, fullPath)
      if (!realPath || isProtectedPath(cwd, realPath)) {
        continue
      }
      const realStat = await stat(realPath)
      if (realStat.isFile() && isLikelyTextFile(realPath, cwd)) {
        files.push(realPath)
      }
    } else if (entry.isFile() && isLikelyTextFile(fullPath, cwd)) {
      files.push(fullPath)
    }
  }

  return files
}

async function resolveSymlinkForSearch(cwd: string, fullPath: string): Promise<string | undefined> {
  try {
    return await resolveRealInsideCwd(cwd, path.relative(cwd, fullPath))
  } catch {
    return undefined
  }
}

async function searchFile(file: string, cwd: string, input: GrepInput, matches: GrepMatch[]): Promise<void> {
  let content: string
  try {
    content = await readFile(file, "utf8")
  } catch {
    return
  }

  const needle = input.caseSensitive ? input.pattern : input.pattern.toLowerCase()
  const lines = content.split(/\r?\n/)

  for (const [index, line] of lines.entries()) {
    const haystack = input.caseSensitive ? line : line.toLowerCase()
    if (haystack.includes(needle)) {
      matches.push({
        path: path.relative(cwd, file),
        line: index + 1,
        text: line.slice(0, 500),
      })
    }

    if (matches.length >= MAX_MATCHES) {
      return
    }
  }
}

function isLikelyTextFile(filePath: string, cwd: string): boolean {
  const relative = path.relative(cwd, filePath)
  if (relative.includes(`${path.sep}node_modules${path.sep}`)) {
    return false
  }

  const ext = path.extname(filePath).toLowerCase()
  return ![".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".gz", ".exe", ".dll"].includes(ext)
}
