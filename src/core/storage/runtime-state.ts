import type {
  AppConfig,
  ModelCatalogEntry,
  ModelRef,
  ProviderConnectionConfig,
  ProviderProtocol,
} from "../config/schema.js"
import type { RuntimeStateStore, SecretStore, SettingsStore } from "./contracts.js"

export class MemorySettingsStore implements SettingsStore {
  private readonly values = new Map<string, unknown>()

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined
  }

  set<T>(key: string, value: T): void {
    this.values.set(key, structuredClone(value))
  }

  delete(key: string): void {
    this.values.delete(key)
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, { value: string; updatedAt: string }>()

  get(provider: string): string | undefined {
    return this.values.get(provider)?.value
  }

  set(provider: string, value: string): void {
    this.values.set(provider, { value, updatedAt: new Date().toISOString() })
  }

  delete(provider: string): void {
    this.values.delete(provider)
  }

  list(): Array<{ provider: string; updatedAt: string }> {
    return [...this.values.entries()]
      .map(([provider, entry]) => ({ provider, updatedAt: entry.updatedAt }))
      .sort((left, right) => left.provider.localeCompare(right.provider))
  }
}

export class MemoryRuntimeStateStore implements RuntimeStateStore {
  readonly settings: SettingsStore
  readonly secrets: SecretStore

  constructor(
    settings: SettingsStore = new MemorySettingsStore(),
    secrets: SecretStore = new MemorySecretStore(),
  ) {
    this.settings = settings
    this.secrets = secrets
  }

  listCustomModels(): ModelCatalogEntry[] {
    return this.settings.get<ModelCatalogEntry[]>("customModels") ?? []
  }

  upsertCustomModel(entry: ModelCatalogEntry): void {
    const models = this.listCustomModels()
    const key = modelKey(entry)
    this.settings.set("customModels", [
      ...models.filter((item) => modelKey(item) !== key),
      entry,
    ])
  }

  deleteCustomModel(provider: string, model: string): void {
    this.settings.set(
      "customModels",
      this.listCustomModels().filter((item) => item.provider !== provider || item.model !== model),
    )
    const active = this.getActiveModel()
    if (active?.provider === provider && active.model === model) {
      this.settings.delete("activeModel")
    }
  }

  setProviderConfig(
    provider: string,
    config: { baseUrl: string; protocol: ProviderProtocol; apiKeyEnv: string },
  ): void {
    const current = this.settings.get<Record<string, ProviderConnectionConfig>>("providerConfigs") ?? {}
    this.settings.set("providerConfigs", {
      ...current,
      [provider]: { ...config },
    })
  }

  getActiveModel(): ModelRef | undefined {
    return this.settings.get<ModelRef>("activeModel")
  }

  setActiveModel(ref: ModelRef): void {
    this.settings.set("activeModel", ref)
  }

  applyOverrides(config: AppConfig): AppConfig {
    const providerConfigs =
      this.settings.get<Record<string, ProviderConnectionConfig>>("providerConfigs") ?? {}
    const providers: AppConfig["providers"] = {
      openaiCompatible: { ...config.providers.openaiCompatible },
      anthropic: { ...config.providers.anthropic },
      gemini: { ...config.providers.gemini },
      custom: { ...config.providers.custom },
    }

    for (const [provider, saved] of Object.entries(providerConfigs)) {
      if (provider === "anthropic") {
        providers.anthropic = { ...providers.anthropic, baseUrl: saved.baseUrl, apiKeyEnv: saved.apiKeyEnv }
      } else if (provider === "gemini") {
        providers.gemini = { ...providers.gemini, baseUrl: saved.baseUrl, apiKeyEnv: saved.apiKeyEnv }
      } else if (provider === "openai-compatible") {
        providers.openaiCompatible = {
          ...providers.openaiCompatible,
          baseUrl: saved.baseUrl,
          apiKeyEnv: saved.apiKeyEnv,
        }
      } else {
        providers.custom[provider] = { ...saved }
      }
    }

    for (const { provider } of this.secrets.list()) {
      const apiKey = this.secrets.get(provider)
      if (!apiKey) continue
      if (provider === "anthropic" && !providers.anthropic.apiKey) {
        providers.anthropic = { ...providers.anthropic, apiKey }
      } else if (provider === "gemini" && !providers.gemini.apiKey) {
        providers.gemini = { ...providers.gemini, apiKey }
      } else if (provider === "openai-compatible" && !providers.openaiCompatible.apiKey) {
        providers.openaiCompatible = { ...providers.openaiCompatible, apiKey }
      } else if (providers.custom[provider] && !providers.custom[provider].apiKey) {
        providers.custom[provider] = { ...providers.custom[provider], apiKey }
      }
    }

    const existing = new Set(config.models.catalog.map(modelKey))
    const customModels = this.listCustomModels().filter((entry) => !existing.has(modelKey(entry)))
    return {
      ...config,
      model: this.getActiveModel() ?? config.model,
      providers,
      models: {
        ...config.models,
        catalog: [...config.models.catalog, ...customModels],
      },
    }
  }
}

function modelKey(entry: ModelRef): string {
  return `${entry.provider}/${entry.model}`
}
