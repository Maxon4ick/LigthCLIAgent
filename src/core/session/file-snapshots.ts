import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { createId } from "../../shared/ids.js"
import { resolveInsideCwd } from "../tools/builtins/path-utils.js"
import type { ToolContext } from "../tools/tool.js"

export interface FileSnapshotRecord {
  id: string
  sessionId: string
  agentId: string
  toolCallId: string
  action: string
  path: string
  beforeSha256: string
  afterSha256: string
  beforeContent: string
  afterContent: string
  createdAt: string
}

export type PublicFileSnapshotRecord = Omit<FileSnapshotRecord, "beforeContent" | "afterContent">

export interface RevertSnapshotResult {
  snapshot: PublicFileSnapshotRecord
  reverted: boolean
  skipped?: string
}

export async function writeFileSnapshot(
  context: ToolContext,
  action: string,
  filePath: string,
  beforeContent: string,
  afterContent: string,
): Promise<{ id: string; relativePath: string }> {
  const record: FileSnapshotRecord = {
    id: createId("snap"),
    sessionId: context.sessionId,
    agentId: context.agentId,
    toolCallId: context.toolCallId,
    action,
    path: path.relative(context.cwd, filePath),
    beforeSha256: sha256(beforeContent),
    afterSha256: sha256(afterContent),
    beforeContent,
    afterContent,
    createdAt: new Date().toISOString(),
  }
  const snapshotPath = snapshotFilePath(context.cwd, record.sessionId, record.id)
  await mkdir(path.dirname(snapshotPath), { recursive: true })
  await writeFile(snapshotPath, `${JSON.stringify(record, null, 2)}\n`, "utf8")
  return {
    id: record.id,
    relativePath: path.relative(context.cwd, snapshotPath),
  }
}

export async function listSessionSnapshots(cwd: string, sessionId: string): Promise<PublicFileSnapshotRecord[]> {
  const directory = snapshotSessionDirectory(cwd, sessionId)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (isMissingFileError(error)) {
      return []
    }
    throw error
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => publicSnapshot(await readSnapshotFile(path.join(directory, entry)))),
  )
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export async function revertSessionSnapshots(
  cwd: string,
  sessionId: string,
  options: { snapshotId?: string; force?: boolean } = {},
): Promise<RevertSnapshotResult[]> {
  const snapshots = options.snapshotId
    ? [await readSnapshotFile(snapshotFilePath(cwd, sessionId, options.snapshotId))]
    : (await readPrivateSessionSnapshots(cwd, sessionId)).reverse()
  const results: RevertSnapshotResult[] = []

  for (const snapshot of snapshots) {
    const target = resolveInsideCwd(cwd, snapshot.path)
    let current = ""
    try {
      current = await readFile(target, "utf8")
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error
      }
    }

    if (!options.force && current && sha256(current) !== snapshot.afterSha256) {
      results.push({
        snapshot: publicSnapshot(snapshot),
        reverted: false,
        skipped: "current file hash does not match snapshot afterSha256",
      })
      continue
    }

    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, snapshot.beforeContent, "utf8")
    results.push({
      snapshot: publicSnapshot(snapshot),
      reverted: true,
    })
  }

  return results
}

function snapshotSessionDirectory(cwd: string, sessionId: string): string {
  return path.resolve(cwd, ".agent-cli", "snapshots", safeSegment(sessionId))
}

function snapshotFilePath(cwd: string, sessionId: string, snapshotId: string): string {
  return path.join(snapshotSessionDirectory(cwd, sessionId), `${safeSegment(snapshotId)}.json`)
}

async function readPrivateSessionSnapshots(cwd: string, sessionId: string): Promise<FileSnapshotRecord[]> {
  const publicSnapshots = await listSessionSnapshots(cwd, sessionId)
  const records = await Promise.all(
    publicSnapshots.map((snapshot) => readSnapshotFile(snapshotFilePath(cwd, sessionId, snapshot.id))),
  )
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

async function readSnapshotFile(filePath: string): Promise<FileSnapshotRecord> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Snapshot file must contain an object")
  }

  const record = parsed as FileSnapshotRecord
  if (
    typeof record.id !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.path !== "string" ||
    typeof record.beforeContent !== "string" ||
    typeof record.afterContent !== "string"
  ) {
    throw new Error("Snapshot file is malformed")
  }

  return record
}

function publicSnapshot(record: FileSnapshotRecord): PublicFileSnapshotRecord {
  const { beforeContent: _beforeContent, afterContent: _afterContent, ...publicRecord } = record
  return publicRecord
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  )
}
