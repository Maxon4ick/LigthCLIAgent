import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { ExternalDirectoryError, isProtectedPath, resolveRealInsideCwd } from "./path-utils.js"
import type { ToolContext, ToolDefinition } from "../tool.js"

interface ListDirectoryInput {
  path?: string
  recursive?: boolean
  maxEntries?: number
}

interface DirectoryEntry {
  path: string
  type: "file" | "directory" | "symlink" | "other"
  size?: number
}

interface ListDirectoryOutput {
  path: string
  entries: DirectoryEntry[]
  truncated: boolean
}

const DEFAULT_MAX_ENTRIES = 200
const HARD_MAX_ENTRIES = 2_000
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"])

export const listDirectoryTool: ToolDefinition<unknown, ListDirectoryOutput> = {
  name: "list_directory",
  description: "List files and directories inside the workspace with structured metadata.",
  kind: "read",
  metadata: {
    safeConcurrent: true,
    mutatesWorkspace: false,
    requiresApproval: false,
    tags: ["files", "list"],
  },
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean" },
      maxEntries: { type: "number" },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    const start = parsed.path ? await resolveReadablePath(context, parsed.path) : context.cwd
    const startStats = await stat(start)
    if (!startStats.isDirectory()) {
      throw new Error("list_directory.path must point to a directory")
    }

    const maxEntries = parsed.maxEntries ?? DEFAULT_MAX_ENTRIES
    const entries: DirectoryEntry[] = []
    await listEntries(start, context.cwd, parsed.recursive ?? false, maxEntries, entries)

    return {
      ok: true,
      output: {
        path: path.relative(context.cwd, start) || ".",
        entries,
        truncated: entries.length >= maxEntries,
      },
    }
  },
}

function parseInput(input: unknown): ListDirectoryInput {
  if (input === undefined) {
    return {}
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("list_directory input must be an object")
  }

  const record = input as Record<string, unknown>
  if (record.path !== undefined && (typeof record.path !== "string" || record.path.length === 0)) {
    throw new Error("list_directory.path must be a non-empty string")
  }
  if (record.recursive !== undefined && typeof record.recursive !== "boolean") {
    throw new Error("list_directory.recursive must be a boolean")
  }
  if (record.maxEntries !== undefined) {
    if (typeof record.maxEntries !== "number" || !Number.isInteger(record.maxEntries) || record.maxEntries <= 0) {
      throw new Error("list_directory.maxEntries must be a positive integer")
    }
    if (record.maxEntries > HARD_MAX_ENTRIES) {
      throw new Error(`list_directory.maxEntries must be <= ${HARD_MAX_ENTRIES}`)
    }
  }

  return {
    path: record.path,
    recursive: record.recursive,
    maxEntries: record.maxEntries,
  }
}

async function resolveReadablePath(context: ToolContext, requestedPath: string): Promise<string> {
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

async function listEntries(
  directory: string,
  cwd: string,
  recursive: boolean,
  maxEntries: number,
  entries: DirectoryEntry[],
): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true })
  children.sort((left, right) => left.name.localeCompare(right.name))

  for (const child of children) {
    if (entries.length >= maxEntries) return
    if (child.name.startsWith(".") && child.name !== ".agent" && child.name !== ".agents") {
      continue
    }

    const fullPath = path.join(directory, child.name)
    if (isProtectedPath(cwd, fullPath)) {
      continue
    }

    const entry = await toEntry(fullPath, cwd, child)
    entries.push(entry)

    if (recursive && child.isDirectory() && !SKIPPED_DIRECTORIES.has(child.name)) {
      await listEntries(fullPath, cwd, recursive, maxEntries, entries)
    }
  }
}

async function toEntry(
  fullPath: string,
  cwd: string,
  entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean },
): Promise<DirectoryEntry> {
  const relativePath = path.relative(cwd, fullPath)
  if (entry.isFile()) {
    const stats = await stat(fullPath)
    return { path: relativePath, type: "file", size: stats.size }
  }
  if (entry.isDirectory()) {
    return { path: relativePath, type: "directory" }
  }
  if (entry.isSymbolicLink()) {
    return { path: relativePath, type: "symlink" }
  }
  return { path: relativePath, type: "other" }
}
