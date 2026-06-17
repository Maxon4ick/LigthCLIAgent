import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { ExternalDirectoryError, isProtectedPath, resolveRealInsideCwd } from "./path-utils.js"
import type { ToolContext, ToolDefinition } from "../tool.js"

interface GlobInput {
  pattern: string
  path?: string
  maxMatches?: number
}

interface GlobOutput {
  pattern: string
  matches: string[]
  truncated: boolean
}

const DEFAULT_MAX_MATCHES = 200
const HARD_MAX_MATCHES = 2_000
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"])

export const globTool: ToolDefinition<unknown, GlobOutput> = {
  name: "glob",
  description: "Find workspace files using * and ** glob patterns.",
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
      maxMatches: { type: "number" },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    const start = parsed.path ? await resolveSearchStart(context, parsed.path) : context.cwd
    const startStats = await stat(start)
    const maxMatches = parsed.maxMatches ?? DEFAULT_MAX_MATCHES
    const expression = globToRegExp(parsed.pattern)
    const matches: string[] = []

    if (startStats.isDirectory()) {
      await walk(start, context.cwd, expression, maxMatches, matches)
    } else {
      const relative = normalizePath(path.relative(context.cwd, start))
      if (expression.test(relative)) {
        matches.push(relative)
      }
    }

    matches.sort((left, right) => left.localeCompare(right))
    return {
      ok: true,
      output: {
        pattern: parsed.pattern,
        matches,
        truncated: matches.length >= maxMatches,
      },
    }
  },
}

function parseInput(input: unknown): GlobInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("glob input must be an object")
  }

  const record = input as Record<string, unknown>
  if (typeof record.pattern !== "string" || record.pattern.length === 0) {
    throw new Error("glob.pattern must be a non-empty string")
  }
  if (record.path !== undefined && typeof record.path !== "string") {
    throw new Error("glob.path must be a string")
  }
  if (record.maxMatches !== undefined) {
    if (typeof record.maxMatches !== "number" || !Number.isInteger(record.maxMatches) || record.maxMatches <= 0) {
      throw new Error("glob.maxMatches must be a positive integer")
    }
    if (record.maxMatches > HARD_MAX_MATCHES) {
      throw new Error(`glob.maxMatches must be <= ${HARD_MAX_MATCHES}`)
    }
  }

  return {
    pattern: record.pattern,
    path: record.path,
    maxMatches: record.maxMatches,
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

async function walk(
  directory: string,
  cwd: string,
  expression: RegExp,
  maxMatches: number,
  matches: string[],
): Promise<void> {
  if (matches.length >= maxMatches) return
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (matches.length >= maxMatches) return
    if (entry.name.startsWith(".") && entry.name !== ".agent" && entry.name !== ".agents") {
      continue
    }

    const fullPath = path.join(directory, entry.name)
    if (isProtectedPath(cwd, fullPath)) {
      continue
    }

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await walk(fullPath, cwd, expression, maxMatches, matches)
      }
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const relative = normalizePath(path.relative(cwd, fullPath))
    if (expression.test(relative)) {
      matches.push(relative)
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern)
  let source = ""
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    const next = normalized[index + 1]
    if (char === "*" && next === "*") {
      source += ".*"
      index += 1
      continue
    }
    if (char === "*") {
      source += "[^/]*"
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    source += escapeRegExp(char ?? "")
  }

  return new RegExp(`^${source}$`, "i")
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "")
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
}
