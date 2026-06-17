import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { addUserPrompt, createRuntime, createSession } from "../src/core/runtime.js"
import { applyPatchTool } from "../src/core/tools/builtins/apply-patch.js"
import { DefaultPermissionPolicy } from "../src/core/permissions/policy.js"
import { EventBus } from "../src/core/events/event-bus.js"
import { InMemorySessionStore } from "../src/core/session/session-store.js"

describe("apply_patch tool", () => {
  it("is denied by default through the scheduler permission layer", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-edit-deny-"))
    await writeFile(path.join(cwd, "sample.txt"), "before", "utf8")
    const runtime = createRuntime(mergeConfig(defaultConfig, { storage: { kind: "memory" } }), cwd)
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "edit sample.txt")

    const result = await runtime.runner.run(session.id)
    const content = await readFile(path.join(cwd, "sample.txt"), "utf8")

    expect(result.toolResults[0]).toMatchObject({
      name: "apply_patch",
      ok: false,
      error: "Permission deny for edit tool apply_patch",
    })
    expect(content).toBe("before")
  })

  it("edits a file and appends an audit record when allowEdit is enabled", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-edit-allow-"))
    await writeFile(path.join(cwd, "sample.txt"), "before", "utf8")
    const runtime = createRuntime(
      mergeConfig(defaultConfig, {
        storage: { kind: "memory" },
        permissions: { allowEdit: true },
      }),
      cwd,
    )
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "edit sample.txt")

    const result = await runtime.runner.run(session.id)
    const content = await readFile(path.join(cwd, "sample.txt"), "utf8")
    const auditRaw = await readFile(path.join(cwd, ".agent-cli", "audit.log"), "utf8")
    const audit = JSON.parse(auditRaw.trim()) as Record<string, unknown>

    expect(result.toolResults[0]).toMatchObject({
      name: "apply_patch",
      ok: true,
    })
    expect(content).toBe("after")
    expect(audit).toMatchObject({
      action: "apply_patch",
      path: "sample.txt",
      replacements: 1,
      sessionId: session.id,
    })
  })

  it("blocks paths outside cwd", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-edit-path-"))
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "agent-cli-edit-outside-"))
    await mkdir(path.join(cwd, ".agent-cli"), { recursive: true })
    await writeFile(path.join(outsideDir, "outside.txt"), "before", "utf8")

    await expect(
      applyPatchTool.execute(
        {
          path: path.relative(cwd, path.join(outsideDir, "outside.txt")),
          oldText: "before",
          newText: "after",
        },
        {
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
          maxOutputBytes: 1_000,
          auditLogPath: path.join(cwd, ".agent-cli", "audit.log"),
          eventBus: new EventBus(),
          sessionStore: new InMemorySessionStore(),
        },
      ),
    ).rejects.toThrow("Path escapes cwd")
  })
})
