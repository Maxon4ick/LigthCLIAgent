import { loadConfig } from "../../core/config/config-loader.js"
import type { AgentMode, AppConfig, PartialDeep } from "../../core/config/schema.js"
import { normalizePromptFileMentions } from "../../core/context/file-mentions.js"
import { addUserPrompt, createRuntime, createSession } from "../../core/runtime.js"
import type { ToolExecution } from "../../core/tools/scheduler.js"

interface RunArgs {
  json: boolean
  allowShell: boolean
  allowEdit: boolean
  allowNetwork: boolean
  askPermissions: boolean
  approvalTimeoutMs?: number
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  storageKind?: AppConfig["storage"]["kind"]
  storagePath?: string
  sessionId?: string
  mode?: AgentMode
  cwd?: string
  prompt: string
}

export async function runCommand(args: string[]): Promise<void> {
  const parsed = parseRunArgs(args)
  const cwd = parsed.cwd ?? process.cwd()
  const config = await loadConfig({
    cwd,
    overrides: createRunOverrides(parsed),
  })
  const runtime = createRuntime(config, cwd)
  const session = parsed.sessionId
    ? runtime.sessions.getSession(parsed.sessionId)
    : createSession(runtime, parsed.mode ? { mode: parsed.mode } : undefined)
  const normalizedPrompt = await normalizePromptFileMentions(cwd, parsed.prompt)
  addUserPrompt(runtime, session.id, normalizedPrompt.prompt)

  const run = runtime.runs.start(session.id)
  const result = await run.promise

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          session: runtime.sessions.getSession(session.id),
          runId: run.runId,
          fileMentions: normalizedPrompt.mentions,
          assistantText: result.assistantText,
          toolResults: result.toolResults,
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  if (result.assistantText.length > 0) {
    process.stdout.write(result.assistantText.endsWith("\n") ? result.assistantText : `${result.assistantText}\n`)
  }

  if (result.toolResults.length > 0) {
    process.stdout.write(formatToolResults(result.toolResults))
  }
}

function parseRunArgs(args: string[]): RunArgs {
  let json = false
  let allowShell = false
  let allowEdit = false
  let allowNetwork = false
  let askPermissions = false
  let approvalTimeoutMs: number | undefined
  let provider: string | undefined
  let model: string | undefined
  let baseUrl: string | undefined
  let apiKey: string | undefined
  let apiKeyEnv: string | undefined
  let storageKind: AppConfig["storage"]["kind"] | undefined
  let storagePath: string | undefined
  let sessionId: string | undefined
  let mode: AgentMode | undefined
  let cwd: string | undefined
  const promptParts: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (parseOptions && arg === "--") {
      parseOptions = false
      continue
    }

    if (parseOptions && arg === "--json") {
      json = true
      continue
    }

    if (parseOptions && arg === "--allow-shell") {
      allowShell = true
      continue
    }

    if (parseOptions && arg === "--allow-edit") {
      allowEdit = true
      continue
    }

    if (parseOptions && arg === "--allow-network") {
      allowNetwork = true
      continue
    }

    if (parseOptions && arg === "--ask-permissions") {
      askPermissions = true
      continue
    }

    if (parseOptions && arg === "--approval-timeout-ms") {
      const value = args[index + 1]
      if (!value) throw new Error("--approval-timeout-ms requires a value")
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--approval-timeout-ms must be a positive integer")
      }
      approvalTimeoutMs = parsed
      index += 1
      continue
    }

    if (parseOptions && arg === "--provider") {
      const value = args[index + 1]
      if (!value) throw new Error("--provider requires a value")
      provider = value
      index += 1
      continue
    }

    if (parseOptions && arg === "--model") {
      const value = args[index + 1]
      if (!value) throw new Error("--model requires a value")
      model = value
      index += 1
      continue
    }

    if (parseOptions && arg === "--base-url") {
      const value = args[index + 1]
      if (!value) throw new Error("--base-url requires a value")
      baseUrl = value
      index += 1
      continue
    }

    if (parseOptions && arg === "--api-key") {
      const value = args[index + 1]
      if (!value) throw new Error("--api-key requires a value")
      apiKey = value
      index += 1
      continue
    }

    if (parseOptions && arg === "--api-key-env") {
      const value = args[index + 1]
      if (!value) throw new Error("--api-key-env requires a value")
      apiKeyEnv = value
      index += 1
      continue
    }

    if (parseOptions && arg === "--storage") {
      const value = args[index + 1]
      if (value !== "memory" && value !== "file" && value !== "sqlite") {
        throw new Error("--storage must be memory, file, or sqlite")
      }
      storageKind = value
      index += 1
      continue
    }

    if (parseOptions && arg === "--storage-path") {
      const value = args[index + 1]
      if (!value) {
        throw new Error("--storage-path requires a value")
      }
      storagePath = value
      index += 1
      continue
    }

    if (parseOptions && arg === "--session") {
      const value = args[index + 1]
      if (!value) {
        throw new Error("--session requires a session id")
      }
      sessionId = value
      index += 1
      continue
    }

    if (parseOptions && arg === "--mode") {
      const value = args[index + 1]
      if (value !== "build" && value !== "plan" && value !== "explore" && value !== "orchestrate") {
        throw new Error("--mode must be build, plan, explore, or orchestrate")
      }
      mode = value
      index += 1
      continue
    }

    if (parseOptions && arg === "--cwd") {
      const value = args[index + 1]
      if (!value) throw new Error("--cwd requires a value")
      cwd = value
      index += 1
      continue
    }

    if (parseOptions && arg.startsWith("-")) {
      throw new Error(`Unknown run argument: ${arg}`)
    }

    promptParts.push(arg)
  }

  const prompt = promptParts.join(" ").trim()
  if (!prompt) {
    throw new Error('Missing prompt. Example: agent-cli run "hello"')
  }

  return {
    json,
    allowShell,
    allowEdit,
    allowNetwork,
    askPermissions,
    approvalTimeoutMs,
    provider,
    model,
    baseUrl,
    apiKey,
    apiKeyEnv,
    storageKind,
    storagePath,
    sessionId,
    mode,
    cwd,
    prompt,
  }
}

function createRunOverrides(args: RunArgs): PartialDeep<AppConfig> | undefined {
  const overrides: PartialDeep<AppConfig> = {}

  if (args.allowShell) {
    overrides.permissions = { allowShell: true }
  }

  if (args.allowEdit) {
    overrides.permissions = { ...overrides.permissions, allowEdit: true }
  }

  if (args.allowNetwork) {
    overrides.permissions = { ...overrides.permissions, allowNetwork: true }
  }

  if (args.askPermissions) {
    overrides.permissions = {
      ...overrides.permissions,
      askForShell: true,
      askForEdit: true,
      askForNetwork: true,
    }
  }

  if (args.approvalTimeoutMs !== undefined) {
    overrides.permissions = {
      ...overrides.permissions,
      approvalTimeoutMs: args.approvalTimeoutMs,
    }
  }

  if (args.provider || args.model) {
    const model: Partial<AppConfig["model"]> = {}
    if (args.provider) model.provider = args.provider
    if (args.model) model.model = args.model
    overrides.model = model
  }

  if (args.baseUrl || args.apiKey || args.apiKeyEnv) {
    overrides.providers = createProviderOverrides(args)
  }

  if (args.storageKind || args.storagePath) {
    const storage: Partial<AppConfig["storage"]> = {}
    if (args.storageKind) storage.kind = args.storageKind
    if (args.storagePath) storage.path = args.storagePath
    overrides.storage = storage
  }

  return Object.keys(overrides).length === 0 ? undefined : overrides
}

function createProviderOverrides(args: RunArgs): PartialDeep<AppConfig>["providers"] {
  const provider = args.provider ?? "openai-compatible"
  const patch = {
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
    ...(args.apiKeyEnv ? { apiKeyEnv: args.apiKeyEnv } : {}),
  }

  if (provider === "anthropic") {
    return { anthropic: patch }
  }

  if (provider === "gemini") {
    return { gemini: patch }
  }

  if (provider !== "openai-compatible") {
    return {
      custom: {
        [provider]: {
          protocol: provider === "openai-chat" ? "openai-chat" : "openai-compatible",
          baseUrl: args.baseUrl ?? "https://api.openai.com/v1/chat/completions",
          ...(args.apiKey ? { apiKey: args.apiKey } : {}),
          apiKeyEnv: args.apiKeyEnv ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`,
        },
      },
    }
  }

  return { openaiCompatible: patch }
}

function formatToolResults(results: ToolExecution[]): string {
  const lines = ["Tool results:"]

  for (const result of results) {
    if (!result.ok) {
      lines.push(`- ${result.name}: error: ${result.error ?? "unknown error"}`)
      continue
    }

    const output = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)
    lines.push(`- ${result.name}: ${output}`)
  }

  return `${lines.join("\n")}\n`
}
