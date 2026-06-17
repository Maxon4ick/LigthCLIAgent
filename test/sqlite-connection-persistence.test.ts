import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig, type AppConfig, type ModelCatalogEntry } from "../src/core/config/schema.js"
import { listModelCatalog } from "../src/core/llm/model-registry.js"
import { createRuntime, createSession, type Runtime } from "../src/core/runtime.js"

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

  it("uses stored OpenAI alias keys for the OpenAI-compatible provider after restart", async () => {
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
      expect(secondRuntime.config.providers.openaiCompatible).toMatchObject({
        baseUrl: "https://example.openai.test/v1",
        apiKey: "test-openai-key",
      })
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
