import BetterSqlite3 from "better-sqlite3"
import { mkdirSync } from "node:fs"
import path from "node:path"
import type { AppConfig, ModelCapabilities, ModelCatalogEntry, ModelCost, ModelRef, ProviderProtocol } from "../config/schema.js"

export class SqliteDatabase {
  readonly db: BetterSqlite3.Database

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new BetterSqlite3(dbPath)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("foreign_keys = ON")
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        model_provider TEXT NOT NULL,
        model_model TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'default',
        mode TEXT NOT NULL DEFAULT 'build',
        title TEXT,
        parent_session_id TEXT,
        summary TEXT,
        todos TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        parts TEXT NOT NULL,
        usage TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

      CREATE TABLE IF NOT EXISTS api_keys (
        provider TEXT PRIMARY KEY,
        api_key TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS custom_models (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        display_name TEXT,
        protocol TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        cost TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, model)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_configs (
        provider TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        protocol TEXT NOT NULL,
        api_key_env TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  }

  // --- API Keys ---

  getApiKey(provider: string): string | undefined {
    const row = this.db
      .prepare("SELECT api_key FROM api_keys WHERE provider = ?")
      .get(provider) as { api_key: string } | undefined
    if (row?.api_key) return row.api_key

    if (provider === "openai-compatible") {
      const legacyRow = this.db
        .prepare(`
          SELECT k.api_key
          FROM api_keys k
          LEFT JOIN provider_configs pc ON pc.provider = k.provider
          WHERE k.provider IN ('openai', 'openai-chat') AND pc.provider IS NULL
          ORDER BY k.updated_at DESC
          LIMIT 1
        `)
        .get() as { api_key: string } | undefined
      return legacyRow?.api_key
    }

    return undefined
  }

  setApiKey(provider: string, apiKey: string): void {
    this.db
      .prepare(
        `INSERT INTO api_keys (provider, api_key, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at`,
      )
      .run(provider, apiKey, new Date().toISOString())
  }

  deleteApiKey(provider: string): void {
    this.db.prepare("DELETE FROM api_keys WHERE provider = ?").run(provider)
  }

  listApiKeys(): { provider: string; updatedAt: string }[] {
    return (
      this.db.prepare("SELECT provider, updated_at FROM api_keys ORDER BY provider").all() as {
        provider: string
        updated_at: string
      }[]
    ).map((row) => ({ provider: row.provider, updatedAt: row.updated_at }))
  }

  // --- Custom Models ---

  upsertCustomModel(entry: ModelCatalogEntry): void {
    this.db
      .prepare(
        `INSERT INTO custom_models (provider, model, display_name, protocol, capabilities, cost, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET
           display_name = excluded.display_name,
           protocol = excluded.protocol,
           capabilities = excluded.capabilities,
           cost = excluded.cost,
           updated_at = excluded.updated_at`,
      )
      .run(
        entry.provider,
        entry.model,
        entry.displayName ?? null,
        entry.protocol,
        JSON.stringify(entry.capabilities),
        entry.cost ? JSON.stringify(entry.cost) : null,
        new Date().toISOString(),
      )
  }

  deleteCustomModel(provider: string, model: string): void {
    this.db
      .prepare("DELETE FROM custom_models WHERE provider = ? AND model = ?")
      .run(provider, model)

    const activeModel = this.getActiveModel()
    if (activeModel?.provider === provider && activeModel.model === model) {
      this.clearActiveModel()
    }
  }

  listCustomModels(): ModelCatalogEntry[] {
    return (this.db.prepare("SELECT * FROM custom_models ORDER BY provider, model").all() as RawCustomModel[]).map(
      rowToModel,
    )
  }

  // --- Settings ---

  getSetting(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined
    return row?.value
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString())
  }

  getActiveModel(): ModelRef | undefined {
    const provider = this.getSetting("active_model_provider")
    const model = this.getSetting("active_model_model")
    if (provider && model) return { provider, model }
    return undefined
  }

  setActiveModel(ref: ModelRef): void {
    this.setSetting("active_model_provider", ref.provider)
    this.setSetting("active_model_model", ref.model)
  }

  clearActiveModel(): void {
    this.db.prepare("DELETE FROM settings WHERE key IN ('active_model_provider', 'active_model_model')").run()
  }

  // --- Provider configs ---

  setProviderConfig(provider: string, cfg: { baseUrl: string; protocol: ProviderProtocol; apiKeyEnv: string }): void {
    this.db
      .prepare(
        `INSERT INTO provider_configs (provider, base_url, protocol, api_key_env, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           base_url = excluded.base_url,
           protocol = excluded.protocol,
           api_key_env = excluded.api_key_env,
           updated_at = excluded.updated_at`,
      )
      .run(provider, cfg.baseUrl, cfg.protocol, cfg.apiKeyEnv, new Date().toISOString())
  }

  listProviderConfigs(): Array<{ provider: string; baseUrl: string; protocol: ProviderProtocol; apiKeyEnv: string }> {
    return (
      this.db.prepare("SELECT provider, base_url, protocol, api_key_env FROM provider_configs ORDER BY provider").all() as Array<{
        provider: string
        base_url: string
        protocol: string
        api_key_env: string
      }>
    ).map((row) => ({
      provider: row.provider,
      baseUrl: row.base_url,
      protocol: row.protocol as ProviderProtocol,
      apiKeyEnv: row.api_key_env,
    }))
  }

  // --- Config overlay ---

  /** Merge all DB-stored settings into a config snapshot. */
  applyOverrides(config: AppConfig): AppConfig {
    // Collect all stored data up front
    const allKeys = new Map(
      (this.db.prepare("SELECT provider, api_key FROM api_keys").all() as Array<{ provider: string; api_key: string }>)
        .map((row) => [row.provider, row.api_key]),
    )
    const providerConfigs = this.listProviderConfigs()
    const activeModel = this.getActiveModel()
    const dbModels = this.listCustomModels()

    // Shallow-copy provider sections so we can mutate safely
    const providers: AppConfig["providers"] = {
      openaiCompatible: { ...config.providers.openaiCompatible },
      anthropic: { ...config.providers.anthropic },
      gemini: { ...config.providers.gemini },
      custom: { ...config.providers.custom },
    }

    // Apply provider configs (base URL, protocol) — sets up custom provider entries
    for (const pc of providerConfigs) {
      if (pc.provider === "anthropic") {
        providers.anthropic = { ...providers.anthropic, baseUrl: pc.baseUrl, apiKeyEnv: pc.apiKeyEnv }
      } else if (pc.provider === "openai-compatible") {
        providers.openaiCompatible = { ...providers.openaiCompatible, baseUrl: pc.baseUrl, apiKeyEnv: pc.apiKeyEnv }
      } else if (pc.provider === "gemini") {
        providers.gemini = { ...providers.gemini, baseUrl: pc.baseUrl, apiKeyEnv: pc.apiKeyEnv }
      } else {
        providers.custom[pc.provider] = {
          ...(providers.custom[pc.provider] ?? { disabled: false }),
          protocol: pc.protocol,
          baseUrl: pc.baseUrl,
          apiKeyEnv: pc.apiKeyEnv,
        }
      }
    }

    // Apply API keys for all providers
    for (const [provider, apiKey] of allKeys) {
      if (provider === "anthropic") {
        providers.anthropic = { ...providers.anthropic, apiKey }
      } else if (provider === "openai-compatible") {
        providers.openaiCompatible = { ...providers.openaiCompatible, apiKey }
      } else if (provider === "gemini") {
        providers.gemini = { ...providers.gemini, apiKey }
      } else if (providers.custom[provider]) {
        providers.custom[provider] = { ...providers.custom[provider], apiKey }
      }
      // Custom provider without a saved config is skipped — key alone isn't enough to connect
    }

    if (!providers.openaiCompatible.apiKey) {
      const legacyOpenAiKey = this.getApiKey("openai-compatible")
      if (legacyOpenAiKey) providers.openaiCompatible = { ...providers.openaiCompatible, apiKey: legacyOpenAiKey }
    }

    // Merge custom models into catalog
    const existingIds = new Set(config.models.catalog.map((e) => `${e.provider}/${e.model}`))
    const newModels = dbModels.filter((m) => !existingIds.has(`${m.provider}/${m.model}`))

    return {
      ...config,
      model: activeModel ?? config.model,
      providers,
      models: {
        ...config.models,
        catalog: [...config.models.catalog, ...newModels],
      },
    }
  }

  close(): void {
    this.db.close()
  }
}

export function resolveDbPath(cwd: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(cwd, configuredPath)
}

interface RawCustomModel {
  provider: string
  model: string
  display_name: string | null
  protocol: string
  capabilities: string
  cost: string | null
  updated_at: string
}

function rowToModel(row: RawCustomModel): ModelCatalogEntry {
  return {
    provider: row.provider,
    model: row.model,
    displayName: row.display_name ?? undefined,
    protocol: row.protocol as ProviderProtocol,
    capabilities: JSON.parse(row.capabilities) as ModelCapabilities,
    cost: row.cost ? (JSON.parse(row.cost) as ModelCost) : undefined,
  }
}
