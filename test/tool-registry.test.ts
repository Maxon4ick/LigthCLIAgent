import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig } from "../src/core/config/schema.js"
import { EventBus } from "../src/core/events/event-bus.js"
import { DefaultPermissionPolicy } from "../src/core/permissions/policy.js"
import { InMemorySessionStore } from "../src/core/session/session-store.js"
import { discoverDiagnosticScripts } from "../src/core/tools/builtins/project-diagnostics.js"
import { createDefaultToolRegistry } from "../src/core/tools/registry.js"

describe("ToolRegistry", () => {
  it("registers built-in tools", () => {
    const registry = createDefaultToolRegistry(defaultConfig)

    expect(registry.get("read_file")).toBeDefined()
    expect(registry.get("grep")).toBeDefined()
    expect(registry.get("shell")).toBeDefined()
    expect(registry.get("apply_patch")).toBeDefined()
    expect(registry.get("use_skill")).toBeDefined()
  })

  it("discovers safe project diagnostic scripts", () => {
    expect(discoverDiagnosticScripts({
      typecheck: "tsc --noEmit",
      test: "vitest run",
      deploy: "publish something",
    }).map((script) => script.name)).toEqual(["test", "typecheck"])
  })

  it("read_file blocks paths outside cwd", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-"))
    const outside = path.join(os.tmpdir(), "agent-cli-outside.txt")
    await writeFile(outside, "secret", "utf8")
    const registry = createDefaultToolRegistry(defaultConfig)
    const tool = registry.get("read_file")

    await expect(
      tool?.execute(
        { path: path.relative(cwd, outside) },
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
            allowEdit: false,
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
