import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { loadConfig } from "../src/core/config/config-loader.js"

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
})
