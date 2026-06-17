import type {
  AppConfig,
  ModelCapabilities,
  ModelCatalogEntry,
  ModelRef,
  ProviderConnectionConfig,
  ProviderProtocol,
} from "../config/schema.js"
import { AnthropicMessagesProvider } from "./providers/anthropic-messages-provider.js"
import { GeminiGenerativeLanguageProvider } from "./providers/gemini-provider.js"
import { MockProvider } from "./mock-provider.js"
import { createOpenAICompatibleProvider, OpenAICompatibleProvider } from "./openai-compatible-provider.js"
import type { ProviderAdapter } from "./provider.js"

export interface ResolvedModel {
  ref: ModelRef
  protocol: ProviderProtocol
  capabilities: ModelCapabilities
  displayName?: string
}

export function createProviderAdapter(config: AppConfig): ProviderAdapter {
  const provider = config.model.provider
  if (provider === "mock") {
    return new MockProvider()
  }

  if (provider === "openai-compatible" || provider === "openai" || provider === "openai-chat") {
    return createOpenAICompatibleProvider(config)
  }

  if (provider === "anthropic") {
    return new AnthropicMessagesProvider(resolveApiConnection(config.providers.anthropic, "anthropic"))
  }

  if (provider === "gemini") {
    return new GeminiGenerativeLanguageProvider(resolveApiConnection(config.providers.gemini, "gemini"))
  }

  const custom = config.providers.custom[provider]
  if (!custom) {
    throw new Error(`Unknown provider: ${provider}`)
  }
  if (custom.disabled) {
    throw new Error(`Provider is disabled: ${provider}`)
  }

  const connection = resolveCustomConnection(custom, provider)
  if (custom.protocol === "openai-chat" || custom.protocol === "openai-compatible") {
    return new OpenAICompatibleProvider(connection)
  }
  if (custom.protocol === "anthropic-messages") {
    return new AnthropicMessagesProvider(connection)
  }
  if (custom.protocol === "gemini-generative-language") {
    return new GeminiGenerativeLanguageProvider(connection)
  }
  if (custom.protocol === "mock") {
    return new MockProvider()
  }

  throw new Error(`Unsupported provider protocol for ${provider}: ${custom.protocol}`)
}

export function listModelCatalog(config: AppConfig): ModelCatalogEntry[] {
  const entries = [...config.models.catalog]
  if (!entries.some((entry) => entry.provider === config.model.provider && entry.model === config.model.model)) {
    entries.push({
      provider: config.model.provider,
      model: config.model.model,
      protocol: protocolForProvider(config, config.model.provider),
      capabilities: {
        tools: true,
        streaming: true,
        usage: true,
        reasoning: false,
        imageInput: false,
      },
    })
  }
  return entries.sort((left, right) => `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`))
}

export function resolveModel(config: AppConfig, ref: ModelRef = config.model): ResolvedModel {
  const entry = config.models.catalog.find((item) => item.provider === ref.provider && item.model === ref.model)
  if (entry) {
    return {
      ref,
      protocol: entry.protocol,
      capabilities: entry.capabilities,
      displayName: entry.displayName,
    }
  }

  return {
    ref,
    protocol: protocolForProvider(config, ref.provider),
    capabilities: {
      tools: true,
      streaming: true,
      usage: true,
      reasoning: false,
      imageInput: false,
    },
  }
}

function protocolForProvider(config: AppConfig, provider: string): ProviderProtocol {
  if (provider === "mock") return "mock"
  if (provider === "anthropic") return "anthropic-messages"
  if (provider === "gemini") return "gemini-generative-language"
  if (provider === "openai" || provider === "openai-chat") return "openai-chat"
  if (provider === "openai-compatible") return "openai-compatible"
  return config.providers.custom[provider]?.protocol ?? "openai-compatible"
}

function resolveApiConnection(
  connection: Omit<ProviderConnectionConfig, "protocol">,
  providerName: string,
): { baseUrl: string; apiKey: string; headers?: Record<string, string>; body?: Record<string, unknown> } {
  const apiKey = connection.apiKey ?? process.env[connection.apiKeyEnv]
  if (!apiKey) {
    throw new Error(`Missing API key for ${providerName} provider. Set ${connection.apiKeyEnv} or configure providers.${providerName}.apiKey.`)
  }

  return {
    baseUrl: connection.baseUrl,
    apiKey,
  }
}

function resolveCustomConnection(
  connection: ProviderConnectionConfig,
  providerName: string,
): { baseUrl: string; apiKey: string; headers?: Record<string, string>; body?: Record<string, unknown> } {
  const apiKey = connection.apiKey ?? process.env[connection.apiKeyEnv]
  if (!apiKey) {
    throw new Error(`Missing API key for custom provider ${providerName}. Set ${connection.apiKeyEnv} or configure apiKey.`)
  }

  return {
    baseUrl: connection.baseUrl,
    apiKey,
    headers: connection.headers,
    body: connection.body,
  }
}
