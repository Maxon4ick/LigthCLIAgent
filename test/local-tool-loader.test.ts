import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  createLocalToolProvider,
  inspectLocalToolManifest,
} from "../src/adapters/local/local-tool-provider.js"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { createRuntime } from "../src/core/runtime.js"

describe("trusted local tool loader", () => {
  it("inspects without executing and loads only after explicit trust", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-local-tools-"))
    const marker = path.join(root, "executed.txt")
    const entry = path.join(root, "index.mjs")
    await writeFile(entry, `
      import { writeFile } from "node:fs/promises";
      await writeFile(${JSON.stringify(marker)}, "yes");
      export async function echo(input) { return { ok: true, output: input.text }; }
    `, "utf8")
    const manifestPath = path.join(root, "agent-tools.json")
    await writeFile(manifestPath, JSON.stringify({
      version: 1,
      id: "team",
      entry: "./index.mjs",
      tools: [{
        export: "echo",
        name: "echo",
        description: "Echo",
        capabilities: ["filesystem.read"],
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" } },
          additionalProperties: false,
        },
      }],
    }), "utf8")
    const inspected = await inspectLocalToolManifest(manifestPath)
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(createRuntime({
      config: mergeConfig(defaultConfig, { storage: { kind: "memory" } }),
      cwd: process.cwd(),
      toolProviders: [await createLocalToolProvider({ manifestPath, trusted: false })],
    })).rejects.toThrow("requires explicit trust")
    const runtime = await createRuntime({
      config: mergeConfig(defaultConfig, { storage: { kind: "memory" } }),
      cwd: process.cwd(),
      toolProviders: [await createLocalToolProvider({ manifestPath, trusted: true })],
    })
    expect(inspected.manifest.id).toBe("team")
    expect(runtime.tools.get("local__team__echo")).toBeDefined()
    await expect(readFile(marker, "utf8")).resolves.toBe("yes")
    await runtime.dispose()
  })
})
