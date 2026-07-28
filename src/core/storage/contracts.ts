import type { AppConfig, ModelCatalogEntry, ModelRef, ProviderProtocol } from "../config/schema.js"
import type { SessionStore } from "../session/session-store.js"

export interface StorageContext {
  cwd: string
  config: AppConfig
  signal: AbortSignal
}

export interface SettingsStore {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  delete(key: string): void
}

export interface SecretStore {
  get(provider: string): string | undefined
  set(provider: string, value: string): void
  delete(provider: string): void
  list(): Array<{ provider: string; updatedAt: string }>
}

export interface RuntimeStateStore {
  settings: SettingsStore
  secrets: SecretStore
  listCustomModels(): ModelCatalogEntry[]
  upsertCustomModel(entry: ModelCatalogEntry): void
  deleteCustomModel(provider: string, model: string): void
  setProviderConfig(
    provider: string,
    config: { baseUrl: string; protocol: ProviderProtocol; apiKeyEnv: string },
  ): void
  applyOverrides(config: AppConfig): AppConfig
  getActiveModel(): ModelRef | undefined
  setActiveModel(ref: ModelRef): void
}

export interface StorageAdapter {
  readonly id: string
  createSessionStore(context: StorageContext): Promise<SessionStore> | SessionStore
  createRuntimeState?(context: StorageContext): Promise<RuntimeStateStore> | RuntimeStateStore
  /** Compatibility surface for older embedders; core never depends on it. */
  readonly legacyDatabase?: unknown
  dispose?(): Promise<void> | void
}
