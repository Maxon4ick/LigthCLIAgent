import { readFile } from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "../tool.js"
import { assertExpectedSha256, commitTextEdit, resolveWritablePath } from "./edit-utils.js"

interface WriteFileInput {
  path: string
  content: string
  expectedSha256?: string
  overwrite?: boolean
  createDirectories?: boolean
}

interface WriteFileOutput {
  path: string
  created: boolean
  beforeSha256: string
  afterSha256: string
  diff: string
  snapshotId: string
  snapshotPath: string
}

export const writeFileTool: ToolDefinition<unknown, WriteFileOutput> = {
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file. Existing files require expectedSha256 unless overwrite is explicitly true.",
  kind: "edit",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: true,
    requiresApproval: true,
    tags: ["files", "write", "diff"],
  },
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      expectedSha256: { type: "string" },
      overwrite: { type: "boolean" },
      createDirectories: { type: "boolean" },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    const filePath = await resolveWritablePath(context, parsed.path)
    const beforeResult = await readExisting(filePath)
    const before = beforeResult.content ?? ""

    if (!beforeResult.exists && parsed.expectedSha256) {
      throw new Error("write_file.expectedSha256 was provided but the target file does not exist")
    }

    if (beforeResult.exists && !parsed.overwrite) {
      assertExpectedSha256(before, parsed.expectedSha256, "write_file")
    }

    if (!beforeResult.exists && parsed.createDirectories === false) {
      throw new Error("write_file.createDirectories must not be false when creating a new file")
    }

    const audit = await commitTextEdit(context, "write_file", filePath, before, parsed.content, {
      auditExtra: {
        created: !beforeResult.exists,
        overwrite: parsed.overwrite ?? false,
      },
    })

    return {
      ok: true,
      output: {
        path: path.relative(context.cwd, filePath),
        created: !beforeResult.exists,
        beforeSha256: audit.beforeSha256,
        afterSha256: audit.afterSha256,
        diff: audit.diff,
        snapshotId: audit.snapshotId,
        snapshotPath: audit.snapshotPath,
      },
    }
  },
}

function parseInput(input: unknown): WriteFileInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("write_file input must be an object")
  }

  const record = input as Record<string, unknown>
  if (typeof record.path !== "string" || record.path.length === 0) {
    throw new Error("write_file.path must be a non-empty string")
  }
  if (typeof record.content !== "string") {
    throw new Error("write_file.content must be a string")
  }
  if (record.expectedSha256 !== undefined && typeof record.expectedSha256 !== "string") {
    throw new Error("write_file.expectedSha256 must be a string")
  }
  if (record.overwrite !== undefined && typeof record.overwrite !== "boolean") {
    throw new Error("write_file.overwrite must be a boolean")
  }
  if (record.createDirectories !== undefined && typeof record.createDirectories !== "boolean") {
    throw new Error("write_file.createDirectories must be a boolean")
  }

  return {
    path: record.path,
    content: record.content,
    expectedSha256: record.expectedSha256,
    overwrite: record.overwrite,
    createDirectories: record.createDirectories,
  }
}

async function readExisting(filePath: string): Promise<{ exists: boolean; content?: string }> {
  try {
    return {
      exists: true,
      content: await readFile(filePath, "utf8"),
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return { exists: false }
    }
    throw error
  }
}
