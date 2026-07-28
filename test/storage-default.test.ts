import { access, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { createRuntime, createSession } from "../src/core/runtime.js"
import { FileSessionStore } from "../src/core/session/file-session-store.js"
import { InMemorySessionStore } from "../src/core/session/session-store.js"
import type { StorageAdapter } from "../src/core/storage/contracts.js"

describe("storage defaults and adapter registry", () => {
  it("uses workspace-relative JSON storage by default", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-default-storage-"))
    expect(defaultConfig.storage).toMatchObject({
      kind: "file",
      path: ".agent-cli/sessions.json",
    })
    const runtime = await createRuntime({ config: defaultConfig, cwd })
    createSession(runtime)
    await runtime.dispose()
    const stored = JSON.parse(await readFile(path.join(cwd, ".agent-cli", "sessions.json"), "utf8"))
    expect(stored).toMatchObject({ version: 2 })
  })

  it("keeps memory storage free of filesystem state", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-memory-storage-"))
    const config = mergeConfig(defaultConfig, { storage: { kind: "memory" } })
    const runtime = await createRuntime({ config, cwd })
    createSession(runtime)
    await runtime.dispose()
    await expect(access(path.join(cwd, ".agent-cli"))).rejects.toThrow()
  })

  it("injects and disposes a custom adapter without shared state", async () => {
    const disposed: string[] = []
    const makeAdapter = (id: string): StorageAdapter => ({
      id: "custom",
      createSessionStore: ({ signal }) => {
        expect(signal.aborted).toBe(false)
        return new InMemorySessionStore()
      },
      dispose: () => { disposed.push(id) },
    })
    const config = {
      ...defaultConfig,
      storage: { ...defaultConfig.storage, kind: "custom" as "file" },
    }
    const first = await createRuntime({ config, cwd: process.cwd(), storageAdapters: [makeAdapter("first")] })
    const second = await createRuntime({ config, cwd: process.cwd(), storageAdapters: [makeAdapter("second")] })
    expect(createSession(first).id).not.toBe(createSession(second).id)
    await first.dispose()
    await second.dispose()
    expect(disposed).toEqual(["first", "second"])
  })

  it("does not overwrite malformed session JSON", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-corrupt-storage-"))
    const filePath = path.join(cwd, "sessions.json")
    const corrupted = '{"version":2,"sessions":['
    await writeFile(filePath, corrupted, "utf8")
    expect(() => new FileSessionStore(filePath)).toThrow(/Invalid JSON.*left unchanged/)
    expect(await readFile(filePath, "utf8")).toBe(corrupted)
  })

  it("rejects a file storage path outside the workspace", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-storage-boundary-"))
    const config = mergeConfig(defaultConfig, { storage: { path: "../sessions.json" } })
    await expect(createRuntime({ config, cwd })).rejects.toThrow(/must stay inside the workspace/)
  })
})
