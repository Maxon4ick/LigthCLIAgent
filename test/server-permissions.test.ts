import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { createRuntime } from "../src/core/runtime.js"
import { startHttpServer } from "../src/server/http-server.js"

describe("HTTP daemon permission approvals", () => {
  it("lists and resolves pending permission requests", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-server-perm-"))
    await writeFile(path.join(cwd, "sample.txt"), "before", "utf8")
    const runtime = createRuntime(
      mergeConfig(defaultConfig, {
        server: { port: 0 },
        storage: { kind: "memory" },
        permissions: { askForEdit: true, approvalTimeoutMs: 1_000 },
      }),
      cwd,
    )
    const server = await startHttpServer(runtime)

    try {
      const created = (await (await fetch(`${server.url}/sessions`, { method: "POST" })).json()) as {
        session: { id: string }
      }
      const sessionId = created.session.id

      const accepted = await fetch(`${server.url}/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "edit sample.txt" }),
      })
      expect(accepted.status).toBe(202)

      const approval = await pollPendingApproval(server.url, sessionId)
      const resolved = await fetch(`${server.url}/sessions/${sessionId}/permissions/${approval.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow" }),
      })
      expect(resolved.status).toBe(200)

      await waitForFileContent(path.join(cwd, "sample.txt"), "after")
    } finally {
      await server.close()
    }
  })

  it("aborts an active run and resolves pending approvals as denied", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-server-abort-"))
    await writeFile(path.join(cwd, "sample.txt"), "before", "utf8")
    const runtime = createRuntime(
      mergeConfig(defaultConfig, {
        server: { port: 0 },
        storage: { kind: "memory" },
        permissions: { askForEdit: true, approvalTimeoutMs: 30_000 },
      }),
      cwd,
    )
    const server = await startHttpServer(runtime)

    try {
      const created = (await (await fetch(`${server.url}/sessions`, { method: "POST" })).json()) as {
        session: { id: string }
      }
      const sessionId = created.session.id

      const accepted = (await (
        await fetch(`${server.url}/sessions/${sessionId}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "edit sample.txt" }),
        })
      ).json()) as { runId: string }
      expect(accepted.runId).toMatch(/^run_/)

      await pollPendingApproval(server.url, sessionId)
      const aborted = await fetch(`${server.url}/sessions/${sessionId}/abort`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: accepted.runId }),
      })
      expect(aborted.status).toBe(202)

      await waitForSessionStatus(runtime, sessionId, "cancelled")
      expect(runtime.approvals.listPending(sessionId)).toEqual([])
      expect(await readFile(path.join(cwd, "sample.txt"), "utf8")).toBe("before")
    } finally {
      await server.close()
    }
  })
})

async function pollPendingApproval(baseUrl: string, sessionId: string): Promise<{ id: string }> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/sessions/${sessionId}/permissions`)
    const body = (await response.json()) as { permissions: Array<{ id: string }> }
    if (body.permissions[0]) {
      return body.permissions[0]
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  throw new Error("Timed out waiting for pending permission")
}

async function waitForFileContent(filePath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if ((await readFile(filePath, "utf8")) === expected) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  throw new Error(`Timed out waiting for ${filePath} to contain ${expected}`)
}

async function waitForSessionStatus(
  runtime: ReturnType<typeof createRuntime>,
  sessionId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (runtime.sessions.getSession(sessionId).status === expected) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  throw new Error(`Timed out waiting for ${sessionId} to become ${expected}`)
}
