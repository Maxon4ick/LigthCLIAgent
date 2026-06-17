import path from "node:path"
import type { ToolContext, ToolDefinition } from "../tool.js"
import {
  assertExpectedSha256,
  commitTextEdit,
  normalizeReplacementLineEndings,
  readEditableFile,
} from "./edit-utils.js"

interface EditInput {
  path: string
  oldText: string
  newText: string
  expectedSha256: string
  replaceAll?: boolean
}

interface EditOutput {
  path: string
  replacements: number
  beforeSha256: string
  afterSha256: string
  diff: string
  snapshotId: string
  snapshotPath: string
}

export const editTool: ToolDefinition<unknown, EditOutput> = {
  name: "edit",
  description: "Safely edit a UTF-8 text file with an expectedSha256 stale-write guard and diff output.",
  kind: "edit",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: true,
    requiresApproval: true,
    tags: ["files", "edit", "diff"],
  },
  inputSchema: {
    type: "object",
    required: ["path", "oldText", "newText", "expectedSha256"],
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
      expectedSha256: { type: "string" },
      replaceAll: { type: "boolean" },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    const { filePath, content: before } = await readEditableFile(context, parsed.path)
    assertExpectedSha256(before, parsed.expectedSha256, "edit")
    const newText = normalizeReplacementLineEndings(before, parsed.newText)
    const occurrences = countOccurrences(before, parsed.oldText)

    if (occurrences === 0) {
      return {
        ok: false,
        error: "oldText was not found in the target file",
      }
    }

    if (!parsed.replaceAll && occurrences > 1) {
      return {
        ok: false,
        error: "oldText appears multiple times; set replaceAll to true or provide a more specific oldText",
      }
    }

    const after = parsed.replaceAll ? before.split(parsed.oldText).join(newText) : before.replace(parsed.oldText, newText)
    const audit = await commitTextEdit(context, "edit", filePath, before, after, {
      replacements: parsed.replaceAll ? occurrences : 1,
      auditExtra: {
        oldTextBytes: Buffer.byteLength(parsed.oldText, "utf8"),
        newTextBytes: Buffer.byteLength(parsed.newText, "utf8"),
      },
    })

    return {
      ok: true,
      output: {
        path: path.relative(context.cwd, filePath),
        replacements: parsed.replaceAll ? occurrences : 1,
        beforeSha256: audit.beforeSha256,
        afterSha256: audit.afterSha256,
        diff: audit.diff,
        snapshotId: audit.snapshotId,
        snapshotPath: audit.snapshotPath,
      },
    }
  },
}

function parseInput(input: unknown): EditInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("edit input must be an object")
  }

  const record = input as Record<string, unknown>
  if (typeof record.path !== "string" || record.path.length === 0) {
    throw new Error("edit.path must be a non-empty string")
  }
  if (typeof record.oldText !== "string" || record.oldText.length === 0) {
    throw new Error("edit.oldText must be a non-empty string")
  }
  if (typeof record.newText !== "string") {
    throw new Error("edit.newText must be a string")
  }
  if (typeof record.expectedSha256 !== "string" || record.expectedSha256.length === 0) {
    throw new Error("edit.expectedSha256 must be a non-empty string")
  }
  if (record.replaceAll !== undefined && typeof record.replaceAll !== "boolean") {
    throw new Error("edit.replaceAll must be a boolean")
  }

  return {
    path: record.path,
    oldText: record.oldText,
    newText: record.newText,
    expectedSha256: record.expectedSha256,
    replaceAll: record.replaceAll,
  }
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}
