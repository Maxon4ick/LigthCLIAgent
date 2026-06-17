import { readFile } from "node:fs/promises"
import path from "node:path"
import { sha256 } from "./edit-utils.js"
import { ExternalDirectoryError, isProtectedPath, resolveRealInsideCwd } from "./path-utils.js"
import type { ToolContext, ToolDefinition } from "../tool.js"

interface ReadFileInput {
  path: string
}

interface ReadFileOutput {
  path: string
  content: string
  truncated: boolean
  sha256: string
  bytes: number
  lineEnding: "lf" | "crlf" | "mixed" | "none"
}

export const readFileTool: ToolDefinition<unknown, ReadFileOutput> = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the current workspace.",
  kind: "read",
  metadata: {
    safeConcurrent: true,
    mutatesWorkspace: false,
    requiresApproval: false,
    tags: ["files", "read"],
  },
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    const filePath = await resolveReadablePath(context, parsed.path)
    await assertProtectedReadAllowed(context, filePath)
    const raw = await readFile(filePath, "utf8")
    const bounded = truncateText(raw, context.maxOutputBytes)

    return {
      ok: true,
      output: {
        path: path.relative(context.cwd, filePath),
        content: bounded.text,
        truncated: bounded.truncated,
        sha256: sha256(raw),
        bytes: Buffer.byteLength(raw, "utf8"),
        lineEnding: detectLineEnding(raw),
      },
    }
  },
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

async function assertProtectedReadAllowed(context: ToolContext, filePath: string): Promise<void> {
  if (!isProtectedPath(context.cwd, filePath)) {
    return
  }

  const resource = path.relative(context.cwd, filePath) || filePath
  const decision = await context.permissionPolicy.decide({
    sessionId: context.sessionId,
    agentId: context.agentId,
    action: "read",
    resources: [resource],
    source: {
      type: "tool",
      toolCallId: context.toolCallId,
      messageId: context.assistantMessageId,
    },
  })

  if (decision !== "allow") {
    throw new Error(`Protected path access denied by permission policy: ${decision}`)
  }
}

function parseInput(input: unknown): ReadFileInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("read_file input must be an object")
  }

  const pathValue = (input as { path?: unknown }).path
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    throw new Error("read_file.path must be a non-empty string")
  }

  return { path: pathValue }
}

function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false }
  }

  return { text: text.slice(0, maxBytes), truncated: true }
}

function detectLineEnding(text: string): ReadFileOutput["lineEnding"] {
  const hasCrLf = text.includes("\r\n")
  const hasLf = /(^|[^\r])\n/.test(text)
  if (hasCrLf && hasLf) return "mixed"
  if (hasCrLf) return "crlf"
  if (hasLf) return "lf"
  return "none"
}
