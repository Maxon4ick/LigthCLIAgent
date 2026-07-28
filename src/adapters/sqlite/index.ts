import type { AppConfig, ModelCatalogEntry, ModelRef, ProviderProtocol } from "../../core/config/schema.js"
import type {
  RuntimeStateStore,
  SecretStore,
  SettingsStore,
  StorageAdapter,
} from "../../core/storage/contracts.js"
import { resolveWorkspacePath } from "../../core/storage/atomic-json-file.js"
import { SqliteDatabase } from "./sqlite-database.js"
import { SqliteSessionStore } from "./sqlite-session-store.js"

export const SQLITE_MISSING_DEPENDENCY_MESSAGE = `SQLite storage is optional and requires "better-sqlite3".
Install it with:
  npm install better-sqlite3
Or use:
  --storage file`

export function createSqliteAdapter(): StorageAdapter {
  let database: SqliteDatabase | undefined
  const ensureDatabase = (cwd: string, config: AppConfig): SqliteDatabase => {
    if (!database) {
      database = new SqliteDatabase(
        resolveWorkspacePath(cwd, config.storage.dbPath, "SQLite storage path"),
      )
    }
    return database
  }

  return {
    id: "sqlite",
    createSessionStore: ({ cwd, config }) =>
      new SqliteSessionStore(ensureDatabase(cwd, config).db),
    createRuntimeState: ({ cwd, config }) =>
      new SqliteRuntimeStateStore(ensureDatabase(cwd, config)),
    get legacyDatabase() {
      return database
    },
    dispose: () => {
      database?.close()
      database = undefined
    },
  }
}

export { SqliteDatabase, resolveDbPath } from "./sqlite-database.js"
export { SqliteSessionStore } from "./sqlite-session-store.js"

class SqliteSettingsStore implements SettingsStore {
  constructor(private readonly database: SqliteDatabase) {}

  get<T>(key: string): T | undefined {
    const value = this.database.getSetting(key)
    return value === undefined ? undefined : JSON.parse(value) as T
  }

  set<T>(key: string, value: T): void {
    this.database.setSetting(key, JSON.stringify(value))
  }

  delete(key: string): void {
    this.database.deleteSetting(key)
  }
}

class SqliteSecretStore implements SecretStore {
  constructor(private readonly database: SqliteDatabase) {}

  get(provider: string): string | undefined {
    return this.database.getApiKey(provider)
  }

  set(provider: string, value: string): void {
    this.database.setApiKey(provider, value)
  }

  delete(provider: string): void {
    this.database.deleteApiKey(provider)
  }

  list(): Array<{ provider: string; updatedAt: string }> {
    return this.database.listApiKeys()
  }
}

class SqliteRuntimeStateStore implements RuntimeStateStore {
  readonly settings: SettingsStore
  readonly secrets: SecretStore

  constructor(private readonly database: SqliteDatabase) {
    this.settings = new SqliteSettingsStore(database)
    this.secrets = new SqliteSecretStore(database)
  }

  listCustomModels(): ModelCatalogEntry[] {
    return this.database.listCustomModels()
  }

  upsertCustomModel(entry: ModelCatalogEntry): void {
    this.database.upsertCustomModel(entry)
  }

  deleteCustomModel(provider: string, model: string): void {
    this.database.deleteCustomModel(provider, model)
  }

  setProviderConfig(
    provider: string,
    config: { baseUrl: string; protocol: ProviderProtocol; apiKeyEnv: string },
  ): void {
    this.database.setProviderConfig(provider, config)
  }

  applyOverrides(config: AppConfig): AppConfig {
    return this.database.applyOverrides(config)
  }

  getActiveModel(): ModelRef | undefined {
    return this.database.getActiveModel()
  }

  setActiveModel(ref: ModelRef): void {
    this.database.setActiveModel(ref)
  }
}
