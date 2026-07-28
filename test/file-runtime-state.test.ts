import { mkdtemp, readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { FileRuntimeStateStore } from "../src/core/storage/file-runtime-state.js"

describe("file runtime settings and secrets", () => {
  it("persists settings separately and never lists secret values", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-file-state-"))
    const first = new FileRuntimeStateStore(cwd)
    first.secrets.set("provider", "live-value-that-must-not-be-listed")
    first.settings.set("theme", "dark")

    const second = new FileRuntimeStateStore(cwd)
    expect(second.settings.get("theme")).toBe("dark")
    const listed = second.secrets.list()
    expect(listed).toEqual([
      expect.objectContaining({ provider: "provider" }),
    ])
    expect(JSON.stringify(listed)).not.toContain("live-value-that-must-not-be-listed")

    const settingsFile = await readFile(path.join(cwd, ".agent-cli", "settings.json"), "utf8")
    expect(settingsFile).toContain('"schema": "agent-cli.settings"')
    if (process.platform !== "win32") {
      const mode = (await stat(path.join(cwd, ".agent-cli", "secrets.json"))).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })
})
