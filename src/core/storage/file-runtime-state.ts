import path from "node:path"
import type { ModelCatalogEntry } from "../config/schema.js"
import { atomicWriteJson, readJsonFile, resolveWorkspacePath, updateJsonFile } from "./atomic-json-file.js"
import type { SecretStore, SettingsStore } from "./contracts.js"
import { MemoryRuntimeStateStore } from "./runtime-state.js"

interface SettingsFile {
  schema: "agent-cli.settings"
  version: 1
  values: Record<string, unknown>
}

interface SecretsFile {
  schema: "agent-cli.secrets"
  version: 1
  values: Record<string, { value: string; updatedAt: string }>
}

export class FileSettingsStore implements SettingsStore {
  constructor(private readonly filePath: string) {}

  get<T>(key: string): T | undefined {
    return loadSettings(this.filePath).values[key] as T | undefined
  }

  set<T>(key: string, value: T): void {
    updateJsonFile(this.filePath, emptySettings, parseSettings, (file) => {
      file.values[key] = structuredClone(value)
    })
  }

  delete(key: string): void {
    updateJsonFile(this.filePath, emptySettings, parseSettings, (file) => {
      delete file.values[key]
    })
  }
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly filePath: string) {}

  get(provider: string): string | undefined {
    return loadSecrets(this.filePath).values[provider]?.value
  }

  set(provider: string, value: string): void {
    updateJsonFile(this.filePath, emptySecrets, parseSecrets, (file) => {
      file.values[provider] = { value, updatedAt: new Date().toISOString() }
    })
  }

  delete(provider: string): void {
    updateJsonFile(this.filePath, emptySecrets, parseSecrets, (file) => {
      delete file.values[provider]
    })
  }

  list(): Array<{ provider: string; updatedAt: string }> {
    return Object.entries(loadSecrets(this.filePath).values)
      .map(([provider, entry]) => ({ provider, updatedAt: entry.updatedAt }))
      .sort((left, right) => left.provider.localeCompare(right.provider))
  }
}

export class FileRuntimeStateStore extends MemoryRuntimeStateStore {
  constructor(cwd: string) {
    super(
      new FileSettingsStore(resolveWorkspacePath(cwd, ".agent-cli/settings.json", "Settings path")),
      new FileSecretStore(resolveWorkspacePath(cwd, ".agent-cli/secrets.json", "Secrets path")),
    )
  }
}

function emptySettings(): SettingsFile {
  return { schema: "agent-cli.settings", version: 1, values: {} }
}

function emptySecrets(): SecretsFile {
  return { schema: "agent-cli.secrets", version: 1, values: {} }
}

function loadSettings(filePath: string): SettingsFile {
  return readJsonFile(filePath, emptySettings, parseSettings)
}

function loadSecrets(filePath: string): SecretsFile {
  return readJsonFile(filePath, emptySecrets, parseSecrets)
}

function parseSettings(value: unknown): SettingsFile {
  if (!isRecord(value) || value.schema !== "agent-cli.settings" || value.version !== 1 || !isRecord(value.values)) {
    throw new Error("Unsupported or malformed settings file")
  }
  return value as unknown as SettingsFile
}

function parseSecrets(value: unknown): SecretsFile {
  if (!isRecord(value) || value.schema !== "agent-cli.secrets" || value.version !== 1 || !isRecord(value.values)) {
    throw new Error("Unsupported or malformed secrets file")
  }
  for (const entry of Object.values(value.values)) {
    if (!isRecord(entry) || typeof entry.value !== "string" || typeof entry.updatedAt !== "string") {
      throw new Error("Malformed secrets file")
    }
  }
  return value as unknown as SecretsFile
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
