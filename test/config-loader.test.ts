import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { loadConfig } from "../src/core/config/config-loader.js"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"

describe("loadConfig", () => {
  it("lets explicit overrides win over environment defaults", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-config-"))
    const previousModel = process.env.OPENAI_COMPATIBLE_MODEL

    try {
      process.env.OPENAI_COMPATIBLE_MODEL = "env-model"
      const config = await loadConfig({
        cwd,
        overrides: {
          model: {
            provider: "mock",
            model: "override-model",
          },
        },
      })

      expect(config.model).toEqual({
        provider: "mock",
        model: "override-model",
      })
    } finally {
      if (previousModel === undefined) {
        delete process.env.OPENAI_COMPATIBLE_MODEL
      } else {
        process.env.OPENAI_COMPATIBLE_MODEL = previousModel
      }
    }
  })

  it("requires positive integer agent iteration and skill prompt budgets", () => {
    expect(() => mergeConfig(defaultConfig, { agent: { maxIterations: 0 } })).toThrow(
      "agent.maxIterations must be a positive integer",
    )
    expect(() => mergeConfig(defaultConfig, { agent: { skillPromptMaxChars: 1.5 } })).toThrow(
      "agent.skillPromptMaxChars must be a positive integer",
    )
  })
})
