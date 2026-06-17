import { loadConfig } from "../../core/config/config-loader.js"
import type { AppConfig } from "../../core/config/schema.js"
import { SqliteDatabase, resolveDbPath } from "../../core/storage/sqlite-db.js"

export async function configCommand(_args: string[]): Promise<void> {
  const loadedConfig = await loadConfig({ cwd: process.cwd() })
  const config = applyStoredConfig(loadedConfig, process.cwd())
  process.stdout.write(`${JSON.stringify(redactConfig(config), null, 2)}\n`)
}

function applyStoredConfig(config: AppConfig, cwd: string): AppConfig {
  if (config.storage.kind !== "sqlite") return config

  const db = new SqliteDatabase(resolveDbPath(cwd, config.storage.dbPath))
  try {
    return db.applyOverrides(config)
  } finally {
    db.close()
  }
}

function redactConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    providers: {
      openaiCompatible: {
        ...config.providers.openaiCompatible,
        apiKey: config.providers.openaiCompatible.apiKey ? "[redacted]" : undefined,
      },
      anthropic: {
        ...config.providers.anthropic,
        apiKey: config.providers.anthropic.apiKey ? "[redacted]" : undefined,
      },
      gemini: {
        ...config.providers.gemini,
        apiKey: config.providers.gemini.apiKey ? "[redacted]" : undefined,
      },
      custom: Object.fromEntries(
        Object.entries(config.providers.custom).map(([name, provider]) => [
          name,
          {
            ...provider,
            apiKey: provider.apiKey ? "[redacted]" : undefined,
          },
        ]),
      ),
    },
  }
}
