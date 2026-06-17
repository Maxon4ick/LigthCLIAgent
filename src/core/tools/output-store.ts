import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { redactValue } from "../security/redaction.js"

export interface ToolOutputReference {
  id: string
  path: string
  bytes: number
  storedAt: string
}

export interface ToolOutputStore {
  store(input: {
    toolCallId: string
    toolName: string
    value: unknown
    bytes: number
  }): Promise<ToolOutputReference>
  cleanup(): Promise<void>
}

export class FileToolOutputStore implements ToolOutputStore {
  constructor(
    private readonly rootPath: string,
    private readonly cwd: string,
    private readonly retentionDays: number,
    private readonly maxStoredBytes: number,
  ) {}

  async store(input: {
    toolCallId: string
    toolName: string
    value: unknown
    bytes: number
  }): Promise<ToolOutputReference> {
    await mkdir(this.rootPath, { recursive: true })
    await this.cleanup()

    const id = safeOutputId(input.toolCallId)
    const outputPath = path.join(this.rootPath, `${id}.json`)
    const value = redactValue(input.value)
    const envelope = {
      version: 1,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      storedAt: new Date().toISOString(),
      bytes: input.bytes,
      truncatedAtStore: false,
      output: value,
    }
    let raw = JSON.stringify(envelope, null, 2)
    if (Buffer.byteLength(raw, "utf8") > this.maxStoredBytes) {
      raw = JSON.stringify(
        {
          ...envelope,
          truncatedAtStore: true,
          output: previewValue(value, this.maxStoredBytes),
        },
        null,
        2,
      )
    }

    await writeFile(outputPath, `${raw}\n`, "utf8")

    return {
      id,
      path: path.relative(this.cwd, outputPath),
      bytes: input.bytes,
      storedAt: envelope.storedAt,
    }
  }

  async cleanup(): Promise<void> {
    const maxAgeMs = this.retentionDays * 24 * 60 * 60 * 1_000
    const cutoff = Date.now() - maxAgeMs
    let entries
    try {
      entries = await readdir(this.rootPath, { withFileTypes: true })
    } catch {
      return
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.startsWith("tool_") && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = path.join(this.rootPath, entry.name)
          try {
            const info = await stat(filePath)
            if (info.mtimeMs < cutoff) {
              await unlink(filePath)
            }
          } catch {
            // Best-effort retention cleanup.
          }
        }),
    )
  }
}

export function resolveToolOutputPath(cwd: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(cwd, configuredPath)
}

function safeOutputId(toolCallId: string): string {
  const safe = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
  return `tool_${safe || "output"}`
}

function previewValue(value: unknown, maxBytes: number): unknown {
  const raw = typeof value === "string" ? value : JSON.stringify(value)
  const preview = raw.slice(0, Math.max(0, maxBytes - 1_000))
  if (typeof value === "string") {
    return preview
  }

  return {
    preview,
  }
}
