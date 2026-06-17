import { readFile } from "node:fs/promises"
import path from "node:path"
import { defaultConfig, mergeConfig, type AppConfig, type PartialDeep } from "./schema.js"

export interface LoadConfigOptions {
  cwd: string
  configPath?: string
  overrides?: PartialDeep<AppConfig>
}

export async function loadConfig(options: LoadConfigOptions): Promise<AppConfig> {
  const configPath = options.configPath ?? path.join(options.cwd, "agent-cli.config.json")
  let config = defaultConfig

  try {
    const raw = await readFile(configPath, "utf8")
    config = mergeConfig(config, JSON.parse(raw) as PartialDeep<AppConfig>)
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }

  config = mergeConfig(config, loadEnvOverrides())

  if (options.overrides) {
    config = mergeConfig(config, options.overrides)
  }

  return config
}

function loadEnvOverrides(): PartialDeep<AppConfig> {
  const overrides: PartialDeep<AppConfig> = {}

  if (process.env.OPENAI_COMPATIBLE_MODEL) {
    overrides.model = {
      provider: "openai-compatible",
      model: process.env.OPENAI_COMPATIBLE_MODEL,
    }
  }

  if (process.env.ANTHROPIC_MODEL) {
    overrides.model = {
      provider: "anthropic",
      model: process.env.ANTHROPIC_MODEL,
    }
  }

  if (process.env.GEMINI_MODEL) {
    overrides.model = {
      provider: "gemini",
      model: process.env.GEMINI_MODEL,
    }
  }

  const openaiCompatible: Partial<AppConfig["providers"]["openaiCompatible"]> = {}
  if (process.env.OPENAI_COMPATIBLE_BASE_URL) {
    openaiCompatible.baseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
  }
  if (process.env.OPENAI_COMPATIBLE_API_KEY) {
    openaiCompatible.apiKey = process.env.OPENAI_COMPATIBLE_API_KEY
  }
  if (process.env.OPENAI_COMPATIBLE_API_KEY_ENV) {
    openaiCompatible.apiKeyEnv = process.env.OPENAI_COMPATIBLE_API_KEY_ENV
  }

  if (Object.keys(openaiCompatible).length > 0) {
    overrides.providers = {
      openaiCompatible,
    }
  }

  const anthropic: Partial<AppConfig["providers"]["anthropic"]> = {}
  if (process.env.ANTHROPIC_BASE_URL) {
    anthropic.baseUrl = process.env.ANTHROPIC_BASE_URL
  }
  if (process.env.ANTHROPIC_API_KEY) {
    anthropic.apiKey = process.env.ANTHROPIC_API_KEY
  }
  if (process.env.ANTHROPIC_API_KEY_ENV) {
    anthropic.apiKeyEnv = process.env.ANTHROPIC_API_KEY_ENV
  }

  if (Object.keys(anthropic).length > 0) {
    overrides.providers = {
      ...overrides.providers,
      anthropic,
    }
  }

  const gemini: Partial<AppConfig["providers"]["gemini"]> = {}
  if (process.env.GEMINI_BASE_URL) {
    gemini.baseUrl = process.env.GEMINI_BASE_URL
  }
  if (process.env.GEMINI_API_KEY) {
    gemini.apiKey = process.env.GEMINI_API_KEY
  }
  if (process.env.GEMINI_API_KEY_ENV) {
    gemini.apiKeyEnv = process.env.GEMINI_API_KEY_ENV
  }

  if (Object.keys(gemini).length > 0) {
    overrides.providers = {
      ...overrides.providers,
      gemini,
    }
  }

  return overrides
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  )
}
