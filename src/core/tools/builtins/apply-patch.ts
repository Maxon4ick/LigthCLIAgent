import path from "node:path"
import type { ToolContext, ToolDefinition } from "../tool.js"
import {
  assertExpectedSha256,
  commitTextEdit,
  normalizeReplacementLineEndings,
  readEditableFile,
} from "./edit-utils.js"

type ApplyPatchInput = ExactReplacementPatchInput | UnifiedDiffPatchInput

interface ExactReplacementPatchInput {
  path: string
  oldText: string
  newText: string
  replaceAll?: boolean
  expectedSha256?: string
}

interface UnifiedDiffPatchInput {
  path: string
  patch: string
  expectedSha256?: string
}

interface ApplyPatchOutput {
  path: string
  replacements: number
  beforeSha256: string
  afterSha256: string
  diff: string
  snapshotId: string
  snapshotPath: string
  auditLogPath: string
}

export const applyPatchTool: ToolDefinition<unknown, ApplyPatchOutput> = {
  name: "apply_patch",
  description:
    "Apply either an exact oldText/newText replacement or a unified diff patch to a UTF-8 text file.",
  kind: "edit",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: true,
    requiresApproval: true,
    tags: ["files", "edit", "patch", "diff"],
  },
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
      patch: { type: "string" },
      expectedSha256: { type: "string" },
      replaceAll: { type: "boolean" },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    const { filePath, content: before } = await readEditableFile(context, parsed.path)
    if (parsed.expectedSha256) {
      assertExpectedSha256(before, parsed.expectedSha256, "apply_patch")
    }

    const patchResult = "patch" in parsed ? applyUnifiedDiff(before, parsed.patch) : applyExactReplacement(before, parsed)
    if (!patchResult.ok) {
      return {
        ok: false,
        error: patchResult.error,
      }
    }

    const audit = await commitTextEdit(context, "apply_patch", filePath, before, patchResult.after, {
      replacements: patchResult.replacements,
      auditExtra: "patch" in parsed
        ? {
            patchBytes: Buffer.byteLength(parsed.patch, "utf8"),
          }
        : {
            oldTextBytes: Buffer.byteLength(parsed.oldText, "utf8"),
            newTextBytes: Buffer.byteLength(parsed.newText, "utf8"),
          },
    })

    return {
      ok: true,
      output: {
        path: path.relative(context.cwd, filePath),
        replacements: patchResult.replacements,
        beforeSha256: audit.beforeSha256,
        afterSha256: audit.afterSha256,
        diff: audit.diff,
        snapshotId: audit.snapshotId,
        snapshotPath: audit.snapshotPath,
        auditLogPath: path.relative(context.cwd, context.auditLogPath),
      },
    }
  },
}

function parseInput(input: unknown): ApplyPatchInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("apply_patch input must be an object")
  }

  const record = input as Record<string, unknown>
  if (typeof record.path !== "string" || record.path.length === 0) {
    throw new Error("apply_patch.path must be a non-empty string")
  }
  const hasPatch = record.patch !== undefined
  const hasExactReplacement = record.oldText !== undefined || record.newText !== undefined
  if (hasPatch && hasExactReplacement) {
    throw new Error("apply_patch accepts either patch or oldText/newText, not both")
  }
  if (!hasPatch && !hasExactReplacement) {
    throw new Error("apply_patch requires patch or oldText/newText")
  }
  if (record.expectedSha256 !== undefined && typeof record.expectedSha256 !== "string") {
    throw new Error("apply_patch.expectedSha256 must be a string")
  }
  if (record.replaceAll !== undefined && typeof record.replaceAll !== "boolean") {
    throw new Error("apply_patch.replaceAll must be a boolean")
  }

  if (hasPatch) {
    if (typeof record.patch !== "string" || record.patch.length === 0) {
      throw new Error("apply_patch.patch must be a non-empty string")
    }
    return {
      path: record.path,
      patch: record.patch,
      expectedSha256: record.expectedSha256,
    }
  }

  if (typeof record.oldText !== "string" || record.oldText.length === 0) {
    throw new Error("apply_patch.oldText must be a non-empty string")
  }
  if (typeof record.newText !== "string") {
    throw new Error("apply_patch.newText must be a string")
  }

  return {
    path: record.path,
    oldText: record.oldText,
    newText: record.newText,
    expectedSha256: record.expectedSha256,
    replaceAll: record.replaceAll,
  }
}

function applyExactReplacement(
  before: string,
  input: ExactReplacementPatchInput,
): { ok: true; after: string; replacements: number } | { ok: false; error: string } {
  const occurrences = countOccurrences(before, input.oldText)

  if (occurrences === 0) {
    return {
      ok: false,
      error: "oldText was not found in the target file",
    }
  }

  if (!input.replaceAll && occurrences > 1) {
    return {
      ok: false,
      error: "oldText appears multiple times; set replaceAll to true or provide a more specific oldText",
    }
  }

  const newText = normalizeReplacementLineEndings(before, input.newText)
  return {
    ok: true,
    after: input.replaceAll ? before.split(input.oldText).join(newText) : before.replace(input.oldText, newText),
    replacements: input.replaceAll ? occurrences : 1,
  }
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

function applyUnifiedDiff(
  before: string,
  patch: string,
): { ok: true; after: string; replacements: number } | { ok: false; error: string } {
  const lineEnding = before.includes("\r\n") ? "\r\n" : "\n"
  const sourceLines = splitPatchComparableLines(before)
  const patchLines = patch.replace(/\r\n/g, "\n").split("\n")
  const output: string[] = []
  let sourceIndex = 0
  let replacements = 0
  let sawHunk = false

  for (let index = 0; index < patchLines.length; index += 1) {
    const line = patchLines[index] ?? ""
    if (!line.startsWith("@@")) {
      continue
    }

    sawHunk = true
    const header = parseHunkHeader(line)
    if (!header) {
      return { ok: false, error: `Invalid unified diff hunk header: ${line}` }
    }

    while (sourceIndex < header.oldStart - 1) {
      output.push(sourceLines[sourceIndex] ?? "")
      sourceIndex += 1
    }

    index += 1
    while (index < patchLines.length) {
      const hunkLine = patchLines[index] ?? ""
      if (hunkLine.startsWith("@@")) {
        index -= 1
        break
      }
      if (hunkLine.startsWith("\\ No newline")) {
        index += 1
        continue
      }
      const marker = hunkLine[0]
      const text = hunkLine.slice(1)
      if (marker === " ") {
        const current = sourceLines[sourceIndex]
        if (current !== text) {
          return { ok: false, error: `Unified diff context mismatch near line ${sourceIndex + 1}` }
        }
        output.push(current)
        sourceIndex += 1
      } else if (marker === "-") {
        const current = sourceLines[sourceIndex]
        if (current !== text) {
          return { ok: false, error: `Unified diff removal mismatch near line ${sourceIndex + 1}` }
        }
        sourceIndex += 1
        replacements += 1
      } else if (marker === "+") {
        output.push(text)
        replacements += 1
      } else if (hunkLine.length === 0) {
        break
      } else {
        return { ok: false, error: `Invalid unified diff line: ${hunkLine}` }
      }
      index += 1
    }
  }

  if (!sawHunk) {
    return { ok: false, error: "Unified diff did not contain any hunks" }
  }

  while (sourceIndex < sourceLines.length) {
    output.push(sourceLines[sourceIndex] ?? "")
    sourceIndex += 1
  }

  const hasFinalNewline = before.endsWith("\n")
  return {
    ok: true,
    after: `${output.join(lineEnding)}${hasFinalNewline ? lineEnding : ""}`,
    replacements,
  }
}

function parseHunkHeader(line: string): { oldStart: number } | undefined {
  const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line)
  if (!match) {
    return undefined
  }

  return { oldStart: Number(match[1]) }
}

function splitPatchComparableLines(value: string): string[] {
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
