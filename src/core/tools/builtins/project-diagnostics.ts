import { spawn } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "../tool.js"

interface ProjectDiagnosticsInput {
  script?: string
  list?: boolean
  timeoutMs?: number
}

interface ProjectDiagnosticsOutput {
  script?: string
  packageManager: string
  command: string
  description: string
  availableScripts: Array<{ name: string; command: string; description: string }>
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const HARD_MAX_TIMEOUT_MS = 600_000
const SAFE_SCRIPT_DESCRIPTIONS: Record<string, string> = {
  build: "Compile the project without publishing or installing dependencies.",
  check: "Run the project's aggregate static checks.",
  lint: "Run source linting.",
  preflight: "Run the repository's build/typecheck/test/smoke gate.",
  smoke: "Run the compiled CLI smoke checks.",
  test: "Run the test suite.",
  typecheck: "Run TypeScript or language-level type checks.",
}

export const projectDiagnosticsTool: ToolDefinition<unknown, ProjectDiagnosticsOutput> = {
  name: "project_diagnostics",
  description: "Discover and run safe package.json diagnostic scripts such as typecheck, test, lint, build, smoke, or preflight.",
  kind: "execute",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: false,
    requiresApproval: true,
    tags: ["diagnostics", "execute"],
  },
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", enum: Object.keys(SAFE_SCRIPT_DESCRIPTIONS) },
      list: { type: "boolean" },
      timeoutMs: { type: "number" },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    const packageJson = await readPackageJson(context.cwd)
    const availableScripts = discoverDiagnosticScripts(packageJson.scripts ?? {})
    const packageManager = await detectPackageManager(context.cwd)

    if (parsed.list) {
      return {
        ok: true,
        output: {
          packageManager,
          command: "",
          description: "Available safe diagnostic scripts.",
          availableScripts,
          exitCode: null,
          stdout: "",
          stderr: "",
          truncated: false,
          timedOut: false,
        },
      }
    }

    const script = parsed.script ?? chooseDefaultScript(availableScripts)
    if (!script || !packageJson.scripts?.[script] || !SAFE_SCRIPT_DESCRIPTIONS[script]) {
      throw new Error(`package.json does not define a supported diagnostic script. Available: ${availableScripts.map((item) => item.name).join(", ") || "none"}`)
    }

    const invocation = packageManagerInvocation(packageManager, script)
    const result = await runCommand(invocation.command, invocation.args, context.cwd, context.maxCaptureBytes ?? context.maxOutputBytes, context.abortSignal, parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    return {
      ok: result.exitCode === 0,
      output: {
        ...result,
        script,
        packageManager,
        command: [invocation.command, ...invocation.args].join(" "),
        description: SAFE_SCRIPT_DESCRIPTIONS[script],
        availableScripts,
      },
      error: result.exitCode === 0 ? undefined : `${script} exited with code ${result.exitCode}`,
    }
  },
}

function parseInput(input: unknown): ProjectDiagnosticsInput {
  if (input === undefined) {
    return {}
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("project_diagnostics input must be an object")
  }

  const record = input as Record<string, unknown>
  if (record.script !== undefined && (typeof record.script !== "string" || !SAFE_SCRIPT_DESCRIPTIONS[record.script])) {
    throw new Error(`project_diagnostics.script must be one of: ${Object.keys(SAFE_SCRIPT_DESCRIPTIONS).join(", ")}`)
  }
  if (record.list !== undefined && typeof record.list !== "boolean") {
    throw new Error("project_diagnostics.list must be a boolean")
  }
  if (record.timeoutMs !== undefined) {
    if (typeof record.timeoutMs !== "number" || !Number.isInteger(record.timeoutMs) || record.timeoutMs <= 0) {
      throw new Error("project_diagnostics.timeoutMs must be a positive integer")
    }
    if (record.timeoutMs > HARD_MAX_TIMEOUT_MS) {
      throw new Error(`project_diagnostics.timeoutMs must be <= ${HARD_MAX_TIMEOUT_MS}`)
    }
  }

  return {
    script: record.script,
    list: record.list,
    timeoutMs: record.timeoutMs,
  }
}

async function readPackageJson(cwd: string): Promise<{ scripts?: Record<string, string> }> {
  const parsed = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as unknown
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json must contain an object")
  }
  return parsed as { scripts?: Record<string, string> }
}

export function discoverDiagnosticScripts(scripts: Record<string, string>): Array<{ name: string; command: string; description: string }> {
  return Object.keys(SAFE_SCRIPT_DESCRIPTIONS)
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => ({
      name,
      command: scripts[name] ?? "",
      description: SAFE_SCRIPT_DESCRIPTIONS[name] ?? "Diagnostic script.",
    }))
}

async function detectPackageManager(cwd: string): Promise<string> {
  if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (await exists(path.join(cwd, "yarn.lock"))) return "yarn"
  return "npm"
}

function packageManagerInvocation(packageManager: string, script: string): { command: string; args: string[] } {
  const command = process.platform === "win32" ? `${packageManager}.cmd` : packageManager
  if (packageManager === "yarn" && script !== "preflight") {
    return { command, args: ["run", script] }
  }
  return { command, args: ["run", script] }
}

function chooseDefaultScript(scripts: Array<{ name: string }>): string | undefined {
  return ["typecheck", "check", "test", "lint", "build"].find((name) => scripts.some((script) => script.name === name))
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  maxBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Omit<ProjectDiagnosticsOutput, "script" | "command" | "packageManager" | "description" | "availableScripts">> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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
      child.kill()
    }, timeoutMs)

    child.stdout?.on("data", (chunk: Buffer) => {
      const bounded = boundText(stdout + chunk.toString("utf8"), maxBytes)
      stdout = bounded.text
      truncated ||= bounded.truncated
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const bounded = boundText(stderr + chunk.toString("utf8"), maxBytes)
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
      resolve({ exitCode, stdout, stderr, truncated, timedOut })
    })
  })
}

function boundText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false }
  }

  return { text: text.slice(0, maxBytes), truncated: true }
}
