import { spawn, type ChildProcess } from "node:child_process"
import { classifyShellCommand, type ShellCommandSegment } from "../../permissions/shell-command.js"
import type { ToolDefinition } from "../tool.js"

interface ShellInput {
  command: string
  timeoutMs?: number
}

interface ShellOutput {
  command: string
  segments: ShellCommandSegment[]
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const HARD_MAX_TIMEOUT_MS = 600_000

export const shellTool: ToolDefinition<unknown, ShellOutput> = {
  name: "shell",
  description: "Run a shell command in the current workspace when policy explicitly allows execution.",
  kind: "execute",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: true,
    requiresApproval: true,
    tags: ["shell", "execute"],
  },
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string" },
      timeoutMs: { type: "number" },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)

    return {
      ok: true,
      output: await runShell(
        parsed.command,
        context.cwd,
        context.maxCaptureBytes ?? context.maxOutputBytes,
        context.abortSignal,
        parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ),
    }
  },
}

function parseInput(input: unknown): ShellInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("shell input must be an object")
  }

  const command = (input as { command?: unknown }).command
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("shell.command must be a non-empty string")
  }

  const timeoutMs = (input as { timeoutMs?: unknown }).timeoutMs
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("shell.timeoutMs must be a positive integer")
    }
    if (timeoutMs > HARD_MAX_TIMEOUT_MS) {
      throw new Error(`shell.timeoutMs must be <= ${HARD_MAX_TIMEOUT_MS}`)
    }
  }

  return { command, timeoutMs }
}

function runShell(
  command: string,
  cwd: string,
  maxBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ShellOutput> {
  return new Promise((resolve, reject) => {
    const segments = classifyShellCommand(command)
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      signal,
    })

    let stdout = ""
    let stderr = ""
    let truncated = false
    let timedOut = false
    let settled = false

    const timeout = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = stdout + chunk.toString("utf8")
      const bounded = boundText(next, maxBytes)
      stdout = bounded.text
      truncated ||= bounded.truncated
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      const next = stderr + chunk.toString("utf8")
      const bounded = boundText(next, maxBytes)
      stderr = bounded.text
      truncated ||= bounded.truncated
    })

    child.on("error", (error) => {
      clearTimeout(timeout)
      if (settled) return
      settled = true
      reject(error)
    })
    child.on("close", (exitCode) => {
      clearTimeout(timeout)
      if (settled) return
      settled = true
      const timeoutMessage = timedOut ? `Command timed out after ${timeoutMs}ms` : ""
      const nextStderr = timeoutMessage ? [stderr, timeoutMessage].filter(Boolean).join("\n") : stderr
      resolve({ command, segments, exitCode, stdout, stderr: nextStderr, truncated, timedOut })
    })
  })
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    })
    killer.on("error", () => {
      child.kill()
    })
    return
  }

  child.kill()
  setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL")
    }
  }, 1_000).unref()
}

function boundText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false }
  }

  return { text: text.slice(0, maxBytes), truncated: true }
}
