import { loadConfig } from "../../core/config/config-loader.js"
import type { AppConfig, PartialDeep } from "../../core/config/schema.js"
import { createRuntime } from "../../core/runtime.js"
import { startHttpServer } from "../../server/http-server.js"

interface ServeArgs {
  host?: string
  port?: number
  authToken?: string
  allowEdit?: boolean
  allowNetwork?: boolean
  askPermissions?: boolean
  approvalTimeoutMs?: number
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  storageKind?: AppConfig["storage"]["kind"]
  storagePath?: string
}

export async function serveCommand(args: string[]): Promise<void> {
  const parsed = parseServeArgs(args)
  const cwd = process.cwd()
  const overrides = createServeOverrides(parsed)
  const config = await loadConfig({
    cwd,
    overrides,
  })
  const runtime = createRuntime(config, cwd)
  const server = await startHttpServer(runtime)

  process.stdout.write(`agent-cli daemon listening on ${server.url}\n`)
}

function createServeOverrides(args: ServeArgs): PartialDeep<AppConfig> | undefined {
  const overrides: PartialDeep<AppConfig> = {}
  const server: Partial<AppConfig["server"]> = {}
  if (args.host !== undefined) {
    server.host = args.host
  }
  if (args.port !== undefined) {
    server.port = args.port
  }
  if (args.authToken !== undefined) {
    server.authToken = args.authToken
  }

  if (Object.keys(server).length > 0) {
    overrides.server = server
  }

  if (args.allowEdit) {
    overrides.permissions = { allowEdit: true }
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

function parseServeArgs(args: string[]): ServeArgs {
  const parsed: ServeArgs = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--host") {
      const host = args[index + 1]
      if (!host) throw new Error("--host requires a value")
      parsed.host = host
      index += 1
      continue
    }

    if (arg === "--port") {
      const value = args[index + 1]
      if (!value) throw new Error("--port requires a value")
      const port = Number(value)
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error("--port must be a valid TCP port")
      }
      parsed.port = port
      index += 1
      continue
    }

    if (arg === "--provider") {
      const value = args[index + 1]
      if (!value) throw new Error("--provider requires a value")
      parsed.provider = value
      index += 1
      continue
    }

    if (arg === "--allow-edit") {
      parsed.allowEdit = true
      continue
    }

    if (arg === "--allow-network") {
      parsed.allowNetwork = true
      continue
    }

    if (arg === "--ask-permissions") {
      parsed.askPermissions = true
      continue
    }

    if (arg === "--approval-timeout-ms") {
      const value = args[index + 1]
      if (!value) throw new Error("--approval-timeout-ms requires a value")
      const parsedTimeout = Number(value)
      if (!Number.isInteger(parsedTimeout) || parsedTimeout <= 0) {
        throw new Error("--approval-timeout-ms must be a positive integer")
      }
      parsed.approvalTimeoutMs = parsedTimeout
      index += 1
      continue
    }

    if (arg === "--model") {
      const value = args[index + 1]
      if (!value) throw new Error("--model requires a value")
      parsed.model = value
      index += 1
      continue
    }

    if (arg === "--base-url") {
      const value = args[index + 1]
      if (!value) throw new Error("--base-url requires a value")
      parsed.baseUrl = value
      index += 1
      continue
    }

    if (arg === "--api-key") {
      const value = args[index + 1]
      if (!value) throw new Error("--api-key requires a value")
      parsed.apiKey = value
      index += 1
      continue
    }

    if (arg === "--api-key-env") {
      const value = args[index + 1]
      if (!value) throw new Error("--api-key-env requires a value")
      parsed.apiKeyEnv = value
      index += 1
      continue
    }

    if (arg === "--storage") {
      const value = args[index + 1]
      if (value !== "memory" && value !== "file" && value !== "sqlite") {
        throw new Error("--storage must be memory, file, or sqlite")
      }
      parsed.storageKind = value
      index += 1
      continue
    }

    if (arg === "--auth-token") {
      const value = args[index + 1]
      if (!value) throw new Error("--auth-token requires a value")
      parsed.authToken = value
      index += 1
      continue
    }

    if (arg === "--storage-path") {
      const value = args[index + 1]
      if (!value) throw new Error("--storage-path requires a value")
      parsed.storagePath = value
      index += 1
      continue
    }

    throw new Error(`Unknown serve argument: ${arg}`)
  }

  return parsed
}

function createProviderOverrides(args: ServeArgs): PartialDeep<AppConfig>["providers"] {
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

  return { openaiCompatible: patch }
}
