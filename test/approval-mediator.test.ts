import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { addUserPrompt, createRuntime, createSession } from "../src/core/runtime.js"

describe("ApprovalMediator", () => {
  it("waits for and applies an allow decision", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-approval-allow-"))
    await writeFile(path.join(cwd, "sample.txt"), "before", "utf8")
    const runtime = createRuntime(
      mergeConfig(defaultConfig, {
        storage: { kind: "memory" },
        permissions: { askForEdit: true, approvalTimeoutMs: 1_000 },
      }),
      cwd,
    )
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "edit sample.txt")

    const run = runtime.runner.run(session.id)
    const approval = await waitForPendingApproval(runtime, session.id)
    runtime.approvals.respond(approval.id, "allow")
    const result = await run

    expect(result.toolResults[0]).toMatchObject({ name: "apply_patch", ok: true })
    expect(await readFile(path.join(cwd, "sample.txt"), "utf8")).toBe("after")
  })

  it("returns deny after approval timeout", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-approval-timeout-"))
    await writeFile(path.join(cwd, "sample.txt"), "before", "utf8")
    const runtime = createRuntime(
      mergeConfig(defaultConfig, {
        storage: { kind: "memory" },
        permissions: { askForEdit: true, approvalTimeoutMs: 25 },
      }),
      cwd,
    )
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "edit sample.txt")

    const result = await runtime.runner.run(session.id)

    expect(result.toolResults[0]).toMatchObject({
      name: "apply_patch",
      ok: false,
      error: "Permission deny for edit tool apply_patch",
    })
    expect(await readFile(path.join(cwd, "sample.txt"), "utf8")).toBe("before")
  })
})

async function waitForPendingApproval(runtime: ReturnType<typeof createRuntime>, sessionId: string): Promise<{ id: string }> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const [approval] = runtime.approvals.listPending(sessionId)
    if (approval) return approval
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  throw new Error("Timed out waiting for pending approval")
}
