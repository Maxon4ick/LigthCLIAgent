import { loadConfig } from "../../core/config/config-loader.js"
import type { AppConfig } from "../../core/config/schema.js"
import { openRuntimeState } from "../../core/storage/open-runtime-state.js"

export async function configCommand(_args: string[]): Promise<void> {
  const loadedConfig = await loadConfig({ cwd: process.cwd() })
  const opened = await openRuntimeState(loadedConfig, process.cwd())
  try {
    const config = opened.state.applyOverrides(loadedConfig)
    process.stdout.write(`${JSON.stringify(redactConfig(config), null, 2)}\n`)
  } finally {
    await opened.dispose()
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
