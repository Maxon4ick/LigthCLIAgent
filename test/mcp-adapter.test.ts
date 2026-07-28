import { describe, expect, it } from "vitest"
import { McpToolProvider, type McpClientLike } from "../src/adapters/mcp/mcp-tool-provider.js"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { createRuntime, createSession } from "../src/core/runtime.js"
import { ToolScheduler } from "../src/core/tools/scheduler.js"

describe("optional MCP adapter", () => {
  it("discovers namespaced tools, invokes through permissions and disconnects", async () => {
    const calls: unknown[] = []
    let closed = 0
    const client: McpClientLike = {
      connect: async () => undefined,
      listTools: async () => [{
        name: "create_issue",
        description: "Create issue",
        inputSchema: {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string" } },
          additionalProperties: false,
        },
      }],
      callTool: async (_name, input) => { calls.push(input); return { created: true } },
      close: async () => { closed += 1 },
    }
    const decisions: string[] = []
    const runtime = await createRuntime({
      config: mergeConfig(defaultConfig, { storage: { kind: "memory" } }),
      cwd: process.cwd(),
      permissionPolicy: {
        decide: async (request) => { decisions.push(String(request.action)); return "allow" },
      },
      toolProviders: [new McpToolProvider({
        config: {
          id: "github",
          transport: "stdio",
          command: "unused",
          enabled: true,
        },
        clientFactory: () => client,
      })],
    })
    const session = createSession(runtime)
    const scheduler = new ToolScheduler({
      registry: runtime.tools,
      permissionPolicy: runtime.approvals,
      eventBus: runtime.events,
      sessionStore: runtime.sessions,
      config: runtime.config,
      maxOutputBytes: 10_000,
      maxCaptureBytes: 10_000,
      auditLogPath: "audit.log",
    })
    const result = await scheduler.executeBatch(
      [{ id: "call", name: "mcp__github__create_issue", input: { title: "P1" } }],
      {
        sessionId: session.id,
        assistantMessageId: "assistant",
        agentId: "default",
        agentMode: "build",
        cwd: process.cwd(),
        abortSignal: new AbortController().signal,
      },
    )
    expect(result[0]).toMatchObject({ ok: true, output: { created: true } })
    expect(decisions).toContain("external.invoke")
    expect(calls).toEqual([{ title: "P1" }])
    await runtime.dispose()
    expect(closed).toBe(1)
  })

  it("isolates an MCP initialization failure from built-ins", async () => {
    const runtime = await createRuntime({
      config: mergeConfig(defaultConfig, { storage: { kind: "memory" } }),
      cwd: process.cwd(),
      toolProviders: [new McpToolProvider({
        config: { id: "broken", transport: "stdio", command: "unused", enabled: true },
        clientFactory: () => ({
          connect: async () => { throw new Error("offline") },
          listTools: async () => [],
          callTool: async () => undefined,
          close: async () => undefined,
        }),
      })],
    })
    expect(runtime.tools.get("read_file")).toBeDefined()
    expect(runtime.tools.get("mcp__broken__anything")).toBeUndefined()
    await runtime.dispose()
  })
})
