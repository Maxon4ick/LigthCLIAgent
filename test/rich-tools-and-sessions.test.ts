import { createHash } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { EventBus } from "../src/core/events/event-bus.js"
import { DefaultPermissionPolicy } from "../src/core/permissions/policy.js"
import { listSessionSnapshots, revertSessionSnapshots } from "../src/core/session/file-snapshots.js"
import { InMemorySessionStore } from "../src/core/session/session-store.js"
import { editTool } from "../src/core/tools/builtins/edit.js"
import { readFileTool } from "../src/core/tools/builtins/read-file.js"
import { writeFileTool } from "../src/core/tools/builtins/write-file.js"
import { createDefaultToolRegistry, ToolRegistry } from "../src/core/tools/registry.js"
import { ToolScheduler } from "../src/core/tools/scheduler.js"
import type { ToolContext, ToolDefinition } from "../src/core/tools/tool.js"

describe("rich coding tools and session edit history", () => {
  it("reads file hashes, enforces stale edit guards, records snapshots, and reverts", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-rich-edit-"))
    const filePath = path.join(cwd, "sample.txt")
    await writeFile(filePath, "before\n", "utf8")
    const context = toolContext(cwd)

    const read = await readFileTool.execute({ path: "sample.txt" }, context)
    expect(read.output?.sha256).toBe(sha256("before\n"))

    await expect(
      editTool.execute(
        {
          path: "sample.txt",
          oldText: "before",
          newText: "after",
          expectedSha256: sha256("stale"),
        },
        context,
      ),
    ).rejects.toThrow("expectedSha256 does not match")

    const edit = await editTool.execute(
      {
        path: "sample.txt",
        oldText: "before",
        newText: "after",
        expectedSha256: read.output?.sha256,
      },
      context,
    )

    expect(edit.ok).toBe(true)
    expect(await readFile(filePath, "utf8")).toBe("after\n")
    expect(edit.output?.diff).toContain("-before")
    expect(edit.output?.diff).toContain("+after")

    const snapshots = await listSessionSnapshots(cwd, "ses_test")
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ action: "edit", path: "sample.txt" })

    const revert = await revertSessionSnapshots(cwd, "ses_test")
    expect(revert[0]).toMatchObject({ reverted: true })
    expect(await readFile(filePath, "utf8")).toBe("before\n")
  })

  it("requires expectedSha256 for existing write_file targets unless overwrite is explicit", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-write-"))
    const filePath = path.join(cwd, "existing.txt")
    await writeFile(filePath, "old", "utf8")
    const context = toolContext(cwd)

    await expect(writeFileTool.execute({ path: "existing.txt", content: "new" }, context)).rejects.toThrow(
      "expectedSha256 is required",
    )

    const result = await writeFileTool.execute(
      { path: "existing.txt", content: "new", expectedSha256: sha256("old") },
      context,
    )

    expect(result.ok).toBe(true)
    expect(result.output?.created).toBe(false)
    expect(await readFile(filePath, "utf8")).toBe("new")
  })

  it("honors disabled built-in tools in the registry", () => {
    const registry = createDefaultToolRegistry(mergeConfig(defaultConfig, { tools: { disabled: ["shell", "web_fetch"] } }))

    expect(registry.get("read_file")).toBeDefined()
    expect(registry.get("shell")).toBeUndefined()
    expect(registry.get("web_fetch")).toBeUndefined()
  })

  it("runs safe read/search tool batches concurrently", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-scheduler-"))
    const registry = new ToolRegistry()
    const slowRead = (name: string): ToolDefinition => ({
      name,
      description: "slow read",
      kind: "read",
      inputSchema: { type: "object" },
      metadata: { safeConcurrent: true },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 75))
        return { ok: true, output: name }
      },
    })
    registry.register(slowRead("read_a"))
    registry.register(slowRead("read_b"))
    const scheduler = new ToolScheduler({
      registry,
      permissionPolicy: new DefaultPermissionPolicy({
        allowShell: false,
        allowEdit: false,
        askForShell: false,
        askForEdit: false,
      }),
      eventBus: new EventBus(),
      sessionStore: new InMemorySessionStore(),
      config: defaultConfig,
      maxOutputBytes: 10_000,
      maxCaptureBytes: 10_000,
      auditLogPath: path.join(cwd, ".agent-cli", "audit.log"),
    })

    const startedAt = Date.now()
    const results = await scheduler.executeBatch(
      [
        { id: "call_a", name: "read_a", input: {} },
        { id: "call_b", name: "read_b", input: {} },
      ],
      {
        sessionId: "ses_test",
        assistantMessageId: "msg_test",
        agentId: "default",
        agentMode: "build",
        cwd,
        abortSignal: new AbortController().signal,
      },
    )

    expect(results.map((result) => result.output)).toEqual(["read_a", "read_b"])
    expect(Date.now() - startedAt).toBeLessThan(140)
  })
})

function toolContext(cwd: string): ToolContext {
  return {
    sessionId: "ses_test",
    assistantMessageId: "msg_test",
    toolCallId: "tool_test",
    agentId: "default",
    agentMode: "build",
    cwd,
    abortSignal: new AbortController().signal,
    permissionPolicy: new DefaultPermissionPolicy({
      allowShell: false,
      allowEdit: true,
      askForShell: false,
      askForEdit: false,
    }),
    config: defaultConfig,
    maxOutputBytes: 10_000,
    maxCaptureBytes: 10_000,
    auditLogPath: path.join(cwd, ".agent-cli", "audit.log"),
    eventBus: new EventBus(),
    sessionStore: new InMemorySessionStore(),
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}
