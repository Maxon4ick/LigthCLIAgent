import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { writeFileSnapshot } from "../../session/file-snapshots.js"
import type { ToolContext } from "../tool.js"
import { ExternalDirectoryError, isInsidePath, resolveInsideCwd, resolveRealInsideCwd } from "./path-utils.js"

export interface EditAuditRecord {
  action: string
  path: string
  replacements?: number
  beforeSha256: string
  afterSha256: string
  diff: string
  snapshotId: string
  snapshotPath: string
  extra?: Record<string, unknown>
}

export async function readEditableFile(context: ToolContext, requestedPath: string): Promise<{ filePath: string; content: string }> {
  const filePath = await resolveEditablePath(context, requestedPath)
  return {
    filePath,
    content: await readFile(filePath, "utf8"),
  }
}

export async function resolveEditablePath(context: ToolContext, requestedPath: string): Promise<string> {
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

export async function resolveWritablePath(context: ToolContext, requestedPath: string): Promise<string> {
  const resolvedPath = resolveInsideCwd(context.cwd, requestedPath)
  try {
    const existing = await stat(resolvedPath)
    if (existing.isDirectory()) {
      throw new Error(`Cannot write directory: ${requestedPath}`)
    }
    return await resolveEditablePath(context, requestedPath)
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }

  const existingParent = await nearestExistingParent(resolvedPath)
  const [realCwd, realParent] = await Promise.all([realpath(path.resolve(context.cwd)), realpath(existingParent)])
  if (!isInsidePath(realCwd, realParent)) {
    throw new Error(`Parent directory resolves outside cwd: ${requestedPath}`)
  }

  return resolvedPath
}

export async function commitTextEdit(
  context: ToolContext,
  action: string,
  filePath: string,
  before: string,
  after: string,
  extra: { replacements?: number; auditExtra?: Record<string, unknown> } = {},
): Promise<EditAuditRecord> {
  const beforeSha256 = sha256(before)
  const afterSha256 = sha256(after)
  const relativePath = path.relative(context.cwd, filePath)
  const diff = createUnifiedDiff(relativePath, before, after)
  const snapshot = await writeFileSnapshot(context, action, filePath, before, after)

  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, after, "utf8")

  const audit: EditAuditRecord = {
    action,
    path: relativePath,
    replacements: extra.replacements,
    beforeSha256,
    afterSha256,
    diff,
    snapshotId: snapshot.id,
    snapshotPath: snapshot.relativePath,
    extra: extra.auditExtra,
  }

  await appendAuditLog(context.auditLogPath, {
    action,
    agentId: context.agentId,
    agentMode: context.agentMode,
    sessionId: context.sessionId,
    toolCallId: context.toolCallId,
    path: relativePath,
    replacements: extra.replacements,
    beforeSha256,
    afterSha256,
    diffBytes: Buffer.byteLength(diff, "utf8"),
    snapshotId: snapshot.id,
    snapshotPath: snapshot.relativePath,
    ...extra.auditExtra,
  })

  return audit
}

export function assertExpectedSha256(content: string, expectedSha256: string | undefined, operation: string): string {
  const actual = sha256(content)
  if (!expectedSha256) {
    throw new Error(`${operation}.expectedSha256 is required for stale-write protection`)
  }

  if (actual !== expectedSha256) {
    throw new Error(`${operation}.expectedSha256 does not match current file content`)
  }

  return actual
}

export function normalizeReplacementLineEndings(fileContent: string, replacement: string): string {
  if (fileContent.includes("\r\n") && !replacement.includes("\r\n")) {
    return replacement.replace(/\n/g, "\r\n")
  }

  return replacement
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function createUnifiedDiff(relativePath: string, before: string, after: string, maxChars = 20_000): string {
  const beforeLines = splitComparableLines(before)
  const afterLines = splitComparableLines(after)
  const lines = [`--- a/${normalizeDiffPath(relativePath)}`, `+++ b/${normalizeDiffPath(relativePath)}`, "@@"]

  for (const line of beforeLines) {
    lines.push(`-${line}`)
  }
  for (const line of afterLines) {
    lines.push(`+${line}`)
  }

  const diff = lines.join("\n")
  if (diff.length <= maxChars) {
    return diff
  }

  return `${diff.slice(0, maxChars)}\n...diff truncated...`
}

export async function appendAuditLog(auditLogPath: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(auditLogPath), { recursive: true })
  await appendFile(auditLogPath, `${JSON.stringify({ createdAt: new Date().toISOString(), ...record })}\n`, "utf8")
}

async function nearestExistingParent(filePath: string): Promise<string> {
  let current = path.dirname(filePath)
  while (true) {
    try {
      const stats = await stat(current)
      if (!stats.isDirectory()) {
        throw new Error(`Parent is not a directory: ${current}`)
      }
      return current
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error
      }
      const parent = path.dirname(current)
      if (parent === current) {
        throw error
      }
      current = parent
    }
  }
}

function splitComparableLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n")
  if (normalized.length === 0) {
    return []
  }

  const lines = normalized.split("\n")
  if (lines[lines.length - 1] === "") {
    lines.pop()
  }
  return lines
}

function normalizeDiffPath(value: string): string {
  return value.replace(/\\/g, "/")
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  )
}
