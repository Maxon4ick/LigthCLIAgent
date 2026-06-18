import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig, type AppConfig, type ModelCatalogEntry } from "../src/core/config/schema.js"
import { listModelCatalog } from "../src/core/llm/model-registry.js"
import { createRuntime, createSession, switchModel, type Runtime } from "../src/core/runtime.js"

describe("SQLite connection persistence", () => {
  it("restores the connected provider, key, model catalog entry, and active model", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-connect-"))
    const config = sqliteConfig()

    const firstRuntime = createRuntime(config, cwd)
    try {
      const db = requireDb(firstRuntime)
      db.setApiKey("anthropic", "test-anthropic-key")
      db.setProviderConfig("anthropic", {
        baseUrl: "https://example.anthropic.test",
        protocol: "anthropic-messages",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      })
      db.upsertCustomModel(modelEntry("anthropic", "claude-test", "anthropic-messages"))
      db.setActiveModel({ provider: "anthropic", model: "claude-test" })
    } finally {
      firstRuntime.db?.close()
    }

    const secondRuntime = createRuntime(config, cwd)
    try {
      expect(secondRuntime.config.model).toEqual({ provider: "anthropic", model: "claude-test" })
      expect(secondRuntime.config.providers.anthropic).toMatchObject({
        baseUrl: "https://example.anthropic.test",
        apiKey: "test-anthropic-key",
      })
      expect(secondRuntime.config.models.catalog).toContainEqual(
        expect.objectContaining({ provider: "anthropic", model: "claude-test" }),
      )

      const session = createSession(secondRuntime)
      expect(session.model).toEqual({ provider: "anthropic", model: "claude-test" })
    } finally {
      secondRuntime.db?.close()
    }
  })

  it("restores stored OpenAI aliases as their own connection after restart", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-openai-alias-"))
    const config = sqliteConfig()

    const firstRuntime = createRuntime(config, cwd)
    try {
      const db = requireDb(firstRuntime)
      db.setApiKey("openai", "test-openai-key")
      db.setProviderConfig("openai", {
        baseUrl: "https://example.openai.test/v1",
        protocol: "openai-chat",
        apiKeyEnv: "OPENAI_API_KEY",
      })
      db.upsertCustomModel(modelEntry("openai", "gpt-test", "openai-chat"))
      db.setActiveModel({ provider: "openai", model: "gpt-test" })
    } finally {
      firstRuntime.db?.close()
    }

    const secondRuntime = createRuntime(config, cwd)
    try {
      expect(secondRuntime.config.model).toEqual({ provider: "openai", model: "gpt-test" })
      expect(secondRuntime.config.providers.custom.openai).toMatchObject({
        baseUrl: "https://example.openai.test/v1",
        apiKey: "test-openai-key",
        protocol: "openai-chat",
      })
    } finally {
      secondRuntime.db?.close()
    }
  })

  it("keeps separate endpoints and keys for named OpenAI-compatible custom connections", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-openai-custom-connections-"))
    const config = sqliteConfig()

    const firstRuntime = createRuntime(config, cwd)
    try {
      const db = requireDb(firstRuntime)
      db.setProviderConfig("openrouter", {
        baseUrl: "https://openrouter.example.test/api/v1",
        protocol: "openai-compatible",
        apiKeyEnv: "OPENROUTER_API_KEY",
      })
      db.setApiKey("openrouter", "test-openrouter-key")
      db.upsertCustomModel(modelEntry("openrouter", "openrouter-model", "openai-compatible"))

      db.setProviderConfig("local-llm", {
        baseUrl: "http://127.0.0.1:11434/v1",
        protocol: "openai-compatible",
        apiKeyEnv: "LOCAL_LLM_API_KEY",
      })
      db.setApiKey("local-llm", "test-local-key")
      db.upsertCustomModel(modelEntry("local-llm", "local-model", "openai-compatible"))
      db.setActiveModel({ provider: "local-llm", model: "local-model" })
    } finally {
      firstRuntime.db?.close()
    }

    const secondRuntime = createRuntime(config, cwd)
    try {
      expect(secondRuntime.config.model).toEqual({ provider: "local-llm", model: "local-model" })
      expect(secondRuntime.config.providers.custom.openrouter).toMatchObject({
        baseUrl: "https://openrouter.example.test/api/v1",
        apiKey: "test-openrouter-key",
      })
      expect(secondRuntime.config.providers.custom["local-llm"]).toMatchObject({
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "test-local-key",
      })
      expect(secondRuntime.config.providers.openaiCompatible.apiKey).toBeUndefined()
      expect(secondRuntime.config.providers.openaiCompatible.baseUrl).toBe(defaultConfig.providers.openaiCompatible.baseUrl)
      expect(secondRuntime.config.models.catalog).toContainEqual(
        expect.objectContaining({ provider: "openrouter", model: "openrouter-model" }),
      )
      expect(secondRuntime.config.models.catalog).toContainEqual(
        expect.objectContaining({ provider: "local-llm", model: "local-model" }),
      )
    } finally {
      secondRuntime.db?.close()
    }
  })

  it("stores OpenAI-compatible keys by exact provider name", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-openai-exact-keys-"))
    const runtime = createRuntime(sqliteConfig(), cwd)
    try {
      const db = requireDb(runtime)
      db.setApiKey("openai-compatible", "test-compatible-key")
      db.setApiKey("openai", "test-openai-key")

      expect(db.getApiKey("openai-compatible")).toBe("test-compatible-key")
      expect(db.getApiKey("openai")).toBe("test-openai-key")
      expect(db.listApiKeys().map((entry) => entry.provider)).toEqual(["openai", "openai-compatible"])
    } finally {
      runtime.db?.close()
    }
  })

  it("persists model switches made after a session is already open", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-switch-active-model-"))
    const config = sqliteConfig()

    const setupRuntime = createRuntime(config, cwd)
    try {
      const db = requireDb(setupRuntime)
      db.setProviderConfig("minimax", {
        baseUrl: "https://example.minimax.test/v1",
        protocol: "openai-compatible",
        apiKeyEnv: "MINIMAX_API_KEY",
      })
      db.setApiKey("minimax", "test-minimax-key")
      db.upsertCustomModel(modelEntry("minimax", "MiniMax-M2.1-highspeed", "openai-compatible"))
    } finally {
      setupRuntime.db?.close()
    }

    const firstRuntime = createRuntime(config, cwd)
    try {
      const session = createSession(firstRuntime)
      switchModel(firstRuntime, session.id, { provider: "minimax", model: "MiniMax-M2.1-highspeed" })
    } finally {
      firstRuntime.db?.close()
    }

    const secondRuntime = createRuntime(config, cwd)
    try {
      expect(secondRuntime.config.model).toEqual({ provider: "minimax", model: "MiniMax-M2.1-highspeed" })
      expect(createSession(secondRuntime).model).toEqual({ provider: "minimax", model: "MiniMax-M2.1-highspeed" })
    } finally {
      secondRuntime.db?.close()
    }
  })

  it("does not restore a deleted custom model that used to be active", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-delete-active-model-"))
    const config = sqliteConfig()

    const firstRuntime = createRuntime(config, cwd)
    try {
      const db = requireDb(firstRuntime)
      db.setProviderConfig("local-test", {
        baseUrl: "http://127.0.0.1:11434/v1",
        protocol: "openai-compatible",
        apiKeyEnv: "LOCAL_TEST_API_KEY",
      })
      db.setApiKey("local-test", "test-local-key")
      db.upsertCustomModel(modelEntry("local-test", "model-to-delete", "openai-compatible"))
      db.setActiveModel({ provider: "local-test", model: "model-to-delete" })

      db.deleteCustomModel("local-test", "model-to-delete")
    } finally {
      firstRuntime.db?.close()
    }

    const secondRuntime = createRuntime(config, cwd)
    try {
      expect(secondRuntime.config.model).toEqual(defaultConfig.model)
      expect(listModelCatalog(secondRuntime.config)).not.toContainEqual(
        expect.objectContaining({ provider: "local-test", model: "model-to-delete" }),
      )
    } finally {
      secondRuntime.db?.close()
    }
  })
})

function sqliteConfig(): AppConfig {
  return mergeConfig(defaultConfig, {
    storage: {
      kind: "sqlite",
      dbPath: ".agent-cli/test-agent.db",
    },
  })
}

function modelEntry(provider: string, model: string, protocol: ModelCatalogEntry["protocol"]): ModelCatalogEntry {
  return {
    provider,
    model,
    protocol,
    capabilities: {
      tools: true,
      streaming: true,
      usage: true,
      reasoning: false,
      imageInput: false,
    },
  }
}

function requireDb(runtime: Runtime): NonNullable<Runtime["db"]> {
  if (!runtime.db) throw new Error("Expected sqlite runtime")
  return runtime.db
}
