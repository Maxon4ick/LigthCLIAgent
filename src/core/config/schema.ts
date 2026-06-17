import type { PermissionRule } from "../permissions/policy.js"

export interface ModelRef {
  provider: string
  model: string
}

export type ProviderProtocol =
  | "mock"
  | "openai-chat"
  | "openai-compatible"
  | "anthropic-messages"
  | "gemini-generative-language"

export interface ModelCapabilities {
  tools: boolean
  streaming: boolean
  usage: boolean
  reasoning: boolean
  imageInput: boolean
  maxContextTokens?: number
  maxOutputTokens?: number
}

export interface ModelCost {
  inputPerMillion?: number
  outputPerMillion?: number
  currency?: string
}

export interface ModelCatalogEntry {
  provider: string
  model: string
  displayName?: string
  protocol: ProviderProtocol
  capabilities: ModelCapabilities
  cost?: ModelCost
}

export interface ProviderConnectionConfig {
  protocol: ProviderProtocol
  baseUrl: string
  apiKey?: string
  apiKeyEnv: string
  headers?: Record<string, string>
  body?: Record<string, unknown>
  disabled?: boolean
}

export type AgentMode = "build" | "plan" | "explore" | "orchestrate"

export interface AppConfig {
  model: ModelRef
  providers: {
    openaiCompatible: {
      baseUrl: string
      apiKey?: string
      apiKeyEnv: string
    }
    anthropic: {
      baseUrl: string
      apiKey?: string
      apiKeyEnv: string
    }
    gemini: {
      baseUrl: string
      apiKey?: string
      apiKeyEnv: string
    }
    custom: Record<string, ProviderConnectionConfig>
  }
  models: {
    catalog: ModelCatalogEntry[]
    fallback?: ModelRef
    small?: ModelRef
  }
  server: {
    host: string
    port: number
    authToken?: string
  }
  storage: {
    kind: "memory" | "file" | "sqlite"
    path: string
    dbPath: string
  }
  permissions: {
    allowShell: boolean
    allowEdit: boolean
    askForShell: boolean
    askForEdit: boolean
    allowNetwork: boolean
    askForNetwork: boolean
    approvalTimeoutMs: number
    approvalsPath: string
    rules: PermissionRule[]
  }
  tools: {
    disabled: string[]
  }
  agent: {
    defaultMode: AgentMode
    compactMaxMessages: number
    skillPaths: string[]
  }
  audit: {
    path: string
  }
  toolOutput: {
    maxBytes: number
    maxStoredBytes: number
    path: string
    retentionDays: number
  }
}

export const defaultConfig: AppConfig = {
  model: { provider: "mock", model: "mock-agent" },
  providers: {
    openaiCompatible: {
      baseUrl: "https://api.openai.com/v1/chat/completions",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
    gemini: {
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKeyEnv: "GEMINI_API_KEY",
    },
    custom: {},
  },
  models: {
    catalog: [
      {
        provider: "mock",
        model: "mock-agent",
        displayName: "Mock Agent",
        protocol: "mock",
        capabilities: {
          tools: true,
          streaming: true,
          usage: false,
          reasoning: false,
          imageInput: false,
        },
      },
      {
        provider: "openai-compatible",
        model: "gpt-4.1-mini",
        displayName: "OpenAI-compatible GPT-4.1 Mini",
        protocol: "openai-compatible",
        capabilities: {
          tools: true,
          streaming: true,
          usage: true,
          reasoning: false,
          imageInput: true,
          maxContextTokens: 1_000_000,
        },
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        displayName: "Claude Sonnet 4.5",
        protocol: "anthropic-messages",
        capabilities: {
          tools: true,
          streaming: true,
          usage: true,
          reasoning: true,
          imageInput: true,
          maxContextTokens: 200_000,
        },
      },
      {
        provider: "gemini",
        model: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        protocol: "gemini-generative-language",
        capabilities: {
          tools: true,
          streaming: true,
          usage: true,
          reasoning: true,
          imageInput: true,
          maxContextTokens: 1_000_000,
        },
      },
    ],
    fallback: { provider: "mock", model: "mock-agent" },
    small: { provider: "mock", model: "mock-agent" },
  },
  server: { host: "127.0.0.1", port: 4170 },
  storage: { kind: "sqlite", path: ".agent-cli/sessions.json", dbPath: ".agent-cli/agent.db" },
  permissions: {
    allowShell: false,
    allowEdit: false,
    askForShell: false,
    askForEdit: false,
    allowNetwork: false,
    askForNetwork: false,
    approvalTimeoutMs: 30_000,
    approvalsPath: ".agent-cli/approvals.json",
    rules: [],
  },
  tools: {
    disabled: [],
  },
  agent: {
    defaultMode: "build",
    compactMaxMessages: 20,
    skillPaths: [".agents/skills", ".qwen/skills", ".codex/skills"],
  },
  audit: { path: ".agent-cli/audit.log" },
  toolOutput: {
    maxBytes: 50_000,
    maxStoredBytes: 5_000_000,
    path: ".agent-cli/tool-output",
    retentionDays: 7,
  },
}

export function validateConfig(value: unknown): AppConfig {
  if (!isRecord(value)) {
    throw new Error("Config must be an object")
  }

  const model = readRecord(value.model, "model")
  const providers = readRecord(value.providers, "providers")
  const openaiCompatible = readRecord(providers.openaiCompatible, "providers.openaiCompatible")
  const anthropic = readRecord(providers.anthropic, "providers.anthropic")
  const gemini = readRecord(providers.gemini, "providers.gemini")
  const models = readRecord(value.models, "models")
  const server = readRecord(value.server, "server")
  const storage = readRecord(value.storage, "storage")
  const permissions = readRecord(value.permissions, "permissions")
  const tools = readRecord(value.tools, "tools")
  const agent = readRecord(value.agent, "agent")
  const audit = readRecord(value.audit, "audit")
  const toolOutput = readRecord(value.toolOutput, "toolOutput")

  return {
    model: {
      provider: readString(model.provider, "model.provider"),
      model: readString(model.model, "model.model"),
    },
    providers: {
      openaiCompatible: {
        baseUrl: readString(openaiCompatible.baseUrl, "providers.openaiCompatible.baseUrl"),
        apiKey: readOptionalString(openaiCompatible.apiKey, "providers.openaiCompatible.apiKey"),
        apiKeyEnv: readString(openaiCompatible.apiKeyEnv, "providers.openaiCompatible.apiKeyEnv"),
      },
      anthropic: {
        baseUrl: readString(anthropic.baseUrl, "providers.anthropic.baseUrl"),
        apiKey: readOptionalString(anthropic.apiKey, "providers.anthropic.apiKey"),
        apiKeyEnv: readString(anthropic.apiKeyEnv, "providers.anthropic.apiKeyEnv"),
      },
      gemini: {
        baseUrl: readString(gemini.baseUrl, "providers.gemini.baseUrl"),
        apiKey: readOptionalString(gemini.apiKey, "providers.gemini.apiKey"),
        apiKeyEnv: readString(gemini.apiKeyEnv, "providers.gemini.apiKeyEnv"),
      },
      custom: readProviderConnections(providers.custom, "providers.custom"),
    },
    models: {
      catalog: readModelCatalog(models.catalog, "models.catalog"),
      fallback: readOptionalModelRef(models.fallback, "models.fallback"),
      small: readOptionalModelRef(models.small, "models.small"),
    },
    server: {
      host: readString(server.host, "server.host"),
      port: readPort(server.port, "server.port"),
      authToken: readOptionalString(server.authToken, "server.authToken"),
    },
    storage: {
      kind: readStorageKind(storage.kind, "storage.kind"),
      path: readString(storage.path, "storage.path"),
      dbPath: readString(storage.dbPath, "storage.dbPath"),
    },
    permissions: {
      allowShell: readBoolean(permissions.allowShell, "permissions.allowShell"),
      allowEdit: readBoolean(permissions.allowEdit, "permissions.allowEdit"),
      askForShell: readBoolean(permissions.askForShell, "permissions.askForShell"),
      askForEdit: readBoolean(permissions.askForEdit, "permissions.askForEdit"),
      allowNetwork: readBoolean(permissions.allowNetwork, "permissions.allowNetwork"),
      askForNetwork: readBoolean(permissions.askForNetwork, "permissions.askForNetwork"),
      approvalTimeoutMs: readPositiveInteger(permissions.approvalTimeoutMs, "permissions.approvalTimeoutMs"),
      approvalsPath: readString(permissions.approvalsPath, "permissions.approvalsPath"),
      rules: readPermissionRules(permissions.rules, "permissions.rules"),
    },
    tools: {
      disabled: readStringArray(tools.disabled, "tools.disabled"),
    },
    agent: {
      defaultMode: readAgentMode(agent.defaultMode, "agent.defaultMode"),
      compactMaxMessages: readPositiveInteger(agent.compactMaxMessages, "agent.compactMaxMessages"),
      skillPaths: readStringArray(agent.skillPaths, "agent.skillPaths"),
    },
    audit: {
      path: readString(audit.path, "audit.path"),
    },
    toolOutput: {
      maxBytes: readPositiveInteger(toolOutput.maxBytes, "toolOutput.maxBytes"),
      maxStoredBytes: readPositiveInteger(toolOutput.maxStoredBytes, "toolOutput.maxStoredBytes"),
      path: readString(toolOutput.path, "toolOutput.path"),
      retentionDays: readPositiveInteger(toolOutput.retentionDays, "toolOutput.retentionDays"),
    },
  }
}

export function mergeConfig(base: AppConfig, patch: PartialDeep<AppConfig>): AppConfig {
  return validateConfig({
    model: { ...base.model, ...patch.model },
    providers: {
      openaiCompatible: {
        ...base.providers.openaiCompatible,
        ...patch.providers?.openaiCompatible,
      },
      anthropic: {
        ...base.providers.anthropic,
        ...patch.providers?.anthropic,
      },
      gemini: {
        ...base.providers.gemini,
        ...patch.providers?.gemini,
      },
      custom: {
        ...base.providers.custom,
        ...patch.providers?.custom,
      },
    },
    models: {
      catalog: patch.models?.catalog ?? base.models.catalog,
      fallback: patch.models?.fallback ?? base.models.fallback,
      small: patch.models?.small ?? base.models.small,
    },
    server: { ...base.server, ...patch.server },
    storage: { ...base.storage, ...(patch.storage as Partial<AppConfig["storage"]> | undefined) },
    permissions: { ...base.permissions, ...patch.permissions },
    tools: { ...base.tools, ...patch.tools },
    agent: { ...base.agent, ...patch.agent },
    audit: { ...base.audit, ...patch.audit },
    toolOutput: { ...base.toolOutput, ...patch.toolOutput },
  })
}

export type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends object ? PartialDeep<T[K]> : T[K]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`)
  }

  return value
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }

  return value
}

function readOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string when provided`)
  }

  return value
}

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`)
  }

  return value
}

function readStorageKind(value: unknown, name: string): AppConfig["storage"]["kind"] {
  if (value === "memory" || value === "file" || value === "sqlite") {
    return value
  }

  throw new Error(`${name} must be "memory", "file", or "sqlite"`)
}

function readAgentMode(value: unknown, name: string): AgentMode {
  if (value === "build" || value === "plan" || value === "explore" || value === "orchestrate") {
    return value
  }

  throw new Error(`${name} must be "build", "plan", "explore", or "orchestrate"`)
}

function readProviderProtocol(value: unknown, name: string): ProviderProtocol {
  if (
    value === "mock" ||
    value === "openai-chat" ||
    value === "openai-compatible" ||
    value === "anthropic-messages" ||
    value === "gemini-generative-language"
  ) {
    return value
  }

  throw new Error(`${name} must be a supported provider protocol`)
}

function readPort(value: unknown, name: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new Error(`${name} must be an integer >= 0`)
  }
  const port = value
  if (port > 65_535) {
    throw new Error(`${name} must be <= 65535`)
  }

  return port
}

function readStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`)
  }

  return value.map((item, index) => readString(item, `${name}[${index}]`))
}

function readOptionalModelRef(value: unknown, name: string): ModelRef | undefined {
  if (value === undefined) {
    return undefined
  }

  const record = readRecord(value, name)
  return {
    provider: readString(record.provider, `${name}.provider`),
    model: readString(record.model, `${name}.model`),
  }
}

function readModelCatalog(value: unknown, name: string): ModelCatalogEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`)
  }

  return value.map((item, index) => {
    const record = readRecord(item, `${name}[${index}]`)
    return {
      provider: readString(record.provider, `${name}[${index}].provider`),
      model: readString(record.model, `${name}[${index}].model`),
      displayName: readOptionalString(record.displayName, `${name}[${index}].displayName`),
      protocol: readProviderProtocol(record.protocol, `${name}[${index}].protocol`),
      capabilities: readModelCapabilities(record.capabilities, `${name}[${index}].capabilities`),
      cost: readOptionalModelCost(record.cost, `${name}[${index}].cost`),
    }
  })
}

function readModelCapabilities(value: unknown, name: string): ModelCapabilities {
  const record = readRecord(value, name)
  return {
    tools: readBoolean(record.tools, `${name}.tools`),
    streaming: readBoolean(record.streaming, `${name}.streaming`),
    usage: readBoolean(record.usage, `${name}.usage`),
    reasoning: readBoolean(record.reasoning, `${name}.reasoning`),
    imageInput: readBoolean(record.imageInput, `${name}.imageInput`),
    maxContextTokens: readOptionalPositiveInteger(record.maxContextTokens, `${name}.maxContextTokens`),
    maxOutputTokens: readOptionalPositiveInteger(record.maxOutputTokens, `${name}.maxOutputTokens`),
  }
}

function readOptionalModelCost(value: unknown, name: string): ModelCost | undefined {
  if (value === undefined) {
    return undefined
  }

  const record = readRecord(value, name)
  return {
    inputPerMillion: readOptionalNonNegativeNumber(record.inputPerMillion, `${name}.inputPerMillion`),
    outputPerMillion: readOptionalNonNegativeNumber(record.outputPerMillion, `${name}.outputPerMillion`),
    currency: readOptionalString(record.currency, `${name}.currency`),
  }
}

function readProviderConnections(value: unknown, name: string): Record<string, ProviderConnectionConfig> {
  if (value === undefined) {
    return {}
  }

  const record = readRecord(value, name)
  const entries: Record<string, ProviderConnectionConfig> = {}

  for (const [key, raw] of Object.entries(record)) {
    const connection = readRecord(raw, `${name}.${key}`)
    entries[key] = {
      protocol: readProviderProtocol(connection.protocol, `${name}.${key}.protocol`),
      baseUrl: readString(connection.baseUrl, `${name}.${key}.baseUrl`),
      apiKey: readOptionalString(connection.apiKey, `${name}.${key}.apiKey`),
      apiKeyEnv: readString(connection.apiKeyEnv, `${name}.${key}.apiKeyEnv`),
      headers: readOptionalStringRecord(connection.headers, `${name}.${key}.headers`),
      body: readOptionalRecord(connection.body, `${name}.${key}.body`),
      disabled: readOptionalBoolean(connection.disabled, `${name}.${key}.disabled`),
    }
  }

  return entries
}

function readOptionalStringRecord(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined
  }

  const record = readRecord(value, name)
  const parsed: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    parsed[key] = readString(item, `${name}.${key}`)
  }
  return parsed
}

function readOptionalRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined
  }

  return readRecord(value, name)
}

function readPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }

  return value
}

function readOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined
  }

  return readPositiveInteger(value, name)
}

function readOptionalNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }

  return value
}

function readOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined
  }

  return readBoolean(value, name)
}

function readPermissionRules(value: unknown, name: string): PermissionRule[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`)
  }

  return value.map((item, index) => {
    const rule = readRecord(item, `${name}[${index}]`)
    const action = readString(rule.action, `${name}[${index}].action`)
    const effect = readString(rule.effect, `${name}[${index}].effect`)

    if (!["*", "read", "search", "execute", "edit", "network", "external_directory"].includes(action)) {
      throw new Error(`${name}[${index}].action must be a permission action or "*"`)
    }

    if (effect !== "allow" && effect !== "deny" && effect !== "ask") {
      throw new Error(`${name}[${index}].effect must be "allow", "deny", or "ask"`)
    }

    return {
      action: action as PermissionRule["action"],
      resource: readString(rule.resource, `${name}[${index}].resource`),
      effect,
      agentId: readOptionalString(rule.agentId, `${name}[${index}].agentId`),
      source: "config",
    }
  })
}
