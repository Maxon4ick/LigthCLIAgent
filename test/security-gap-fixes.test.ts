import http, { type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig, type AppConfig } from "../src/core/config/schema.js"
import {
  createRememberedApprovalRule,
  RulesetPermissionPolicy,
  type PermissionPolicy,
  type PermissionRequest,
} from "../src/core/permissions/policy.js"
import { classifyShellCommand, commandPermissionResources } from "../src/core/permissions/shell-command.js"
import { addUserPrompt, createRuntime, createSession } from "../src/core/runtime.js"
import { REDACTED_SECRET } from "../src/core/security/redaction.js"
import { InMemorySessionStore } from "../src/core/session/session-store.js"
import { applyPatchTool } from "../src/core/tools/builtins/apply-patch.js"
import { grepTool } from "../src/core/tools/builtins/grep.js"
import { readFileTool } from "../src/core/tools/builtins/read-file.js"
import { shellTool } from "../src/core/tools/builtins/shell.js"
import { FileToolOutputStore } from "../src/core/tools/output-store.js"
import { ToolRegistry } from "../src/core/tools/registry.js"
import { ToolScheduler } from "../src/core/tools/scheduler.js"
import type { ToolDefinition } from "../src/core/tools/tool.js"
import { EventBus } from "../src/core/events/event-bus.js"
import { startHttpServer } from "../src/server/http-server.js"

describe("security gap fixes", () => {
  it("asks before protected file reads and lets deny rules override allow rules", async () => {
    const baseRequest: PermissionRequest = {
      sessionId: "ses_test",
      agentId: "default",
      action: "read",
      resources: [".env"],
      source: { type: "tool", toolCallId: "tool_test" },
    }

    const defaultPolicy = new RulesetPermissionPolicy(legacyPermissionOptions())
    await expect(defaultPolicy.decide(baseRequest)).resolves.toBe("ask")

    const allowPolicy = new RulesetPermissionPolicy({
      ...legacyPermissionOptions(),
      rules: [{ action: "read", resource: ".env", effect: "allow" }],
    })
    await expect(allowPolicy.decide(baseRequest)).resolves.toBe("allow")

    const denyPolicy = new RulesetPermissionPolicy({
      ...legacyPermissionOptions(),
      rules: [
        { action: "read", resource: ".env", effect: "allow" },
        { action: "read", resource: ".env", effect: "deny" },
      ],
    })
    await expect(denyPolicy.decide(baseRequest)).resolves.toBe("deny")
  })

  it("scopes shell approvals to parsed command segments", async () => {
    const resources = commandPermissionResources("npm test && echo done")
    expect(resources).toEqual(["npm test*", "echo done"])

    const policy = new RulesetPermissionPolicy({
      ...legacyPermissionOptions(),
      rules: [{ action: "execute", resource: "npm test*", effect: "allow" }],
    })

    await expect(policy.decide({
      sessionId: "ses_test",
      agentId: "default",
      action: "execute",
      resources,
      source: { type: "tool", toolCallId: "tool_test" },
    })).resolves.toBe("deny")

    expect(createRememberedApprovalRule({
      sessionId: "ses_test",
      agentId: "default",
      action: "execute",
      resources,
      source: { type: "tool", toolCallId: "tool_test" },
    })).toBeUndefined()

    expect(classifyShellCommand("npm run typecheck | findstr error")[0]).toMatchObject({
      approvalResource: "npm run typecheck*",
      readOnly: true,
    })
  })

  it("remembers an always approval for a concrete resource", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-remember-"))
    await writeFile(path.join(cwd, "sample.txt"), "before", "utf8")
    const runtime = createRuntime(
      mergeConfig(defaultConfig, {
        storage: { kind: "memory" },
        permissions: { askForEdit: true, approvalTimeoutMs: 1_000 },
      }),
      cwd,
    )

    const first = createSession(runtime)
    addUserPrompt(runtime, first.id, "edit sample.txt")
    const run = runtime.runner.run(first.id)
    const approval = await waitForPendingApproval(runtime, first.id)
    runtime.approvals.respond(approval.id, "always")
    await run
    expect(await readFile(path.join(cwd, "sample.txt"), "utf8")).toBe("after")

    await writeFile(path.join(cwd, "sample.txt"), "before", "utf8")
    const second = createSession(runtime)
    addUserPrompt(runtime, second.id, "edit sample.txt")
    const result = await runtime.runner.run(second.id)

    expect(result.toolResults[0]).toMatchObject({ name: "apply_patch", ok: true })
    expect(runtime.approvals.listPending(second.id)).toEqual([])
    expect(await readFile(path.join(cwd, "sample.txt"), "utf8")).toBe("after")
  })

  it("blocks symlink escapes for read_file and apply_patch without external approval", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-symlink-"))
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "agent-cli-outside-"))
    const outsideFile = path.join(outsideDir, "secret.txt")
    const linkPath = path.join(cwd, "link.txt")
    await writeFile(outsideFile, "before", "utf8")

    try {
      await symlink(outsideFile, linkPath, "file")
    } catch (error) {
      if (isSymlinkPrivilegeError(error)) return
      throw error
    }

    await expect(readFileTool.execute({ path: "link.txt" }, toolContext(cwd))).rejects.toThrow(
      "External directory access denied",
    )

    await expect(
      applyPatchTool.execute({ path: "link.txt", oldText: "before", newText: "after" }, toolContext(cwd)),
    ).rejects.toThrow("External directory access denied")
    expect(await readFile(outsideFile, "utf8")).toBe("before")
  })

  it("blocks protected file reads through workspace symlinks", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-protected-symlink-"))
    const envPath = path.join(cwd, ".env")
    const linkPath = path.join(cwd, "public.txt")
    await writeFile(envPath, "OPENAI_API_KEY=sk-testtesttesttesttesttesttest", "utf8")

    try {
      await symlink(envPath, linkPath, "file")
    } catch (error) {
      if (isSymlinkPrivilegeError(error)) return
      throw error
    }

    await expect(readFileTool.execute({ path: "public.txt" }, toolContext(cwd))).rejects.toThrow(
      "Protected path access denied",
    )
  })

  it("does not grep protected files during recursive search", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-grep-"))
    await writeFile(path.join(cwd, ".env"), "needle=secret", "utf8")
    await writeFile(path.join(cwd, "public.txt"), "needle=public", "utf8")

    const result = await grepTool.execute({ pattern: "needle" }, toolContext(cwd))

    expect(result.ok).toBe(true)
    expect(result.output?.matches).toEqual([{ path: "public.txt", line: 1, text: "needle=public" }])
  })

  it("redacts tool results before they are sent back to the provider", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-redact-provider-"))
    await writeFile(path.join(cwd, ".env"), "OPENAI_API_KEY=sk-testtesttesttesttesttesttest", "utf8")
    const requests: unknown[] = []
    let requestCount = 0
    const fake = await startFakeOpenAI(async (request, response) => {
      requestCount += 1
      requests.push(JSON.parse(await readBody(request)) as unknown)
      if (requestCount === 1) {
        writeSse(response, [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_read_env",
                      type: "function",
                      function: { name: "read_file", arguments: "{\"path\":\".env\"}" },
                    },
                  ],
                },
              },
            ],
          },
        ])
        return
      }

      writeSse(response, [{ choices: [{ delta: { content: "done" } }] }])
    })

    try {
      const runtime = createRuntime(
        mergeConfig(openAIConfig(fake.baseUrl), {
          permissions: {
            rules: [{ action: "read", resource: ".env", effect: "allow" }],
          },
        }),
        cwd,
      )
      const session = createSession(runtime)
      addUserPrompt(runtime, session.id, "read .env")
      await runtime.runner.run(session.id)
      addUserPrompt(runtime, session.id, "continue")
      await runtime.runner.run(session.id)

      const secondRequest = JSON.stringify(requests[1])
      expect(secondRequest).not.toContain("sk-testtesttesttesttesttesttest")
      expect(secondRequest).toContain(REDACTED_SECRET)
      const storedMessages = JSON.stringify(runtime.sessions.listMessages(session.id))
      expect(storedMessages).not.toContain("sk-testtesttesttesttesttesttest")
    } finally {
      await fake.close()
    }
  })

  it("stores large tool outputs out of line and keeps only a preview in scheduler results", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-output-store-"))
    const registry = new ToolRegistry()
    const bigTool: ToolDefinition = {
      name: "big_output",
      description: "Return a large string",
      kind: "read",
      inputSchema: { type: "object" },
      async execute() {
        return { ok: true, output: "x".repeat(2_000) }
      },
    }
    registry.register(bigTool)

    const scheduler = new ToolScheduler({
      registry,
      permissionPolicy: new RulesetPermissionPolicy(legacyPermissionOptions()),
      eventBus: new EventBus(),
      sessionStore: new InMemorySessionStore(),
      config: defaultConfig,
      maxOutputBytes: 100,
      maxCaptureBytes: 2_000,
      auditLogPath: path.join(cwd, ".agent-cli", "audit.log"),
      outputStore: new FileToolOutputStore(path.join(cwd, ".agent-cli", "tool-output"), cwd, 7, 10_000),
    })

    const [result] = await scheduler.executeBatch([{ id: "call_big", name: "big_output", input: {} }], {
      sessionId: "ses_test",
      assistantMessageId: "msg_test",
      agentId: "default",
      agentMode: "build",
      cwd,
      abortSignal: new AbortController().signal,
    })

    expect(result?.output).toMatchObject({
      truncated: true,
      bytes: 2_000,
      outputRef: { path: path.join(".agent-cli", "tool-output", "tool_call_big.json") },
    })
    await expect(readFile(path.join(cwd, ".agent-cli", "tool-output", "tool_call_big.json"), "utf8")).resolves.toContain(
      "big_output",
    )
  })

  it("does not execute later sequential tools after the batch is aborted", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-abort-batch-"))
    const controller = new AbortController()
    const registry = new ToolRegistry()
    let laterToolRan = false

    registry.register({
      name: "abort_now",
      description: "Abort the batch",
      kind: "execute",
      inputSchema: { type: "object" },
      async execute() {
        controller.abort(new Error("test abort"))
        return { ok: true, output: "aborted" }
      },
    })
    registry.register({
      name: "later_tool",
      description: "Should not run",
      kind: "execute",
      inputSchema: { type: "object" },
      async execute() {
        laterToolRan = true
        return { ok: true, output: "ran" }
      },
    })

    const results = await schedulerFor(
      cwd,
      registry,
      new RulesetPermissionPolicy({ ...legacyPermissionOptions(), allowShell: true }),
    ).executeBatch(
      [
        { id: "call_abort", name: "abort_now", input: {} },
        { id: "call_later", name: "later_tool", input: {} },
      ],
      {
        sessionId: "ses_test",
        assistantMessageId: "msg_test",
        agentId: "default",
        agentMode: "build",
        cwd,
        abortSignal: controller.signal,
      },
    )

    expect(results.map((result) => result.name)).toEqual(["abort_now"])
    expect(laterToolRan).toBe(false)
  })

  it("does not execute a tool when abort happens during approval", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-abort-approval-"))
    const controller = new AbortController()
    const registry = new ToolRegistry()
    let toolRan = false

    registry.register({
      name: "approved_after_abort",
      description: "Should not run after abort",
      kind: "execute",
      inputSchema: { type: "object" },
      async execute() {
        toolRan = true
        return { ok: true, output: "ran" }
      },
    })

    const permissionPolicy: PermissionPolicy = {
      async decide() {
        controller.abort(new Error("test abort"))
        return "allow"
      },
    }

    const [result] = await schedulerFor(cwd, registry, permissionPolicy).executeBatch(
      [{ id: "call_abort_after_approval", name: "approved_after_abort", input: {} }],
      {
        sessionId: "ses_test",
        assistantMessageId: "msg_test",
        agentId: "default",
        agentMode: "build",
        cwd,
        abortSignal: controller.signal,
      },
    )

    expect(result).toMatchObject({ ok: false, error: "Tool execution aborted" })
    expect(toolRan).toBe(false)
  })

  it("terminates shell commands on timeout", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-shell-timeout-"))
    const startedAt = Date.now()
    const result = await shellTool.execute(
      { command: `"${process.execPath}" -e "setTimeout(function(){}, 2000)"`, timeoutMs: 50 },
      toolContext(cwd),
    )

    expect(result.ok).toBe(true)
    expect(result.output?.timedOut).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(1_500)
  })

  it("refuses to start the HTTP server on an external host without auth", async () => {
    const runtime = createRuntime(
      mergeConfig(defaultConfig, {
        server: { host: "0.0.0.0", port: 0 },
        storage: { kind: "memory" },
      }),
      process.cwd(),
    )

    await expect(startHttpServer(runtime)).rejects.toThrow("non-loopback host without server.authToken")
  })
})

function legacyPermissionOptions(): ConstructorParameters<typeof RulesetPermissionPolicy>[0] {
  return {
    allowShell: false,
    allowEdit: false,
    askForShell: false,
    askForEdit: false,
  }
}

function toolContext(cwd: string): Parameters<typeof readFileTool.execute>[1] {
  return {
    sessionId: "ses_test",
    assistantMessageId: "msg_test",
    toolCallId: "tool_test",
    agentId: "default",
    agentMode: "build",
    cwd,
    abortSignal: new AbortController().signal,
    permissionPolicy: new RulesetPermissionPolicy(legacyPermissionOptions()),
    config: defaultConfig,
    maxOutputBytes: 1_000,
    maxCaptureBytes: 2_000,
    auditLogPath: path.join(cwd, ".agent-cli", "audit.log"),
    eventBus: new EventBus(),
    sessionStore: new InMemorySessionStore(),
  }
}

function schedulerFor(cwd: string, registry: ToolRegistry, permissionPolicy: PermissionPolicy): ToolScheduler {
  return new ToolScheduler({
    registry,
    permissionPolicy,
    eventBus: new EventBus(),
    sessionStore: new InMemorySessionStore(),
    config: defaultConfig,
    maxOutputBytes: 1_000,
    maxCaptureBytes: 2_000,
    auditLogPath: path.join(cwd, ".agent-cli", "audit.log"),
  })
}

async function waitForPendingApproval(runtime: ReturnType<typeof createRuntime>, sessionId: string): Promise<{ id: string }> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const [approval] = runtime.approvals.listPending(sessionId)
    if (approval) return approval
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  throw new Error("Timed out waiting for pending approval")
}

function isSymlinkPrivilegeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "EPERM" || (error as { code?: string }).code === "EACCES")
  )
}

function openAIConfig(baseUrl: string): AppConfig {
  return mergeConfig(defaultConfig, {
    model: {
      provider: "openai-compatible",
      model: "test-model",
    },
    providers: {
      openaiCompatible: {
        baseUrl,
        apiKey: "test-key",
      },
    },
    storage: {
      kind: "memory",
    },
  })
}

async function startFakeOpenAI(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" })
      response.end(error instanceof Error ? error.message : String(error))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  if (typeof address !== "object" || !address) {
    throw new Error("Fake server did not bind to a TCP port")
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function writeSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
  })

  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  response.end("data: [DONE]\n\n")
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })
}
