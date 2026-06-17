import { describe, expect, it } from "vitest"
import {
  getTranscriptScrollMax,
  parseTuiCommand,
  renderPermissionRequest,
  renderScreen,
  renderSessionList,
  renderStatusPanel,
  renderSlashCommandMenu,
  renderWelcome,
  suggestSlashCommands,
} from "../src/cli/tui/render.js"
import { defaultConfig, type AppConfig } from "../src/core/config/schema.js"
import type { PendingApproval } from "../src/core/permissions/approvals.js"
import type { Message, Session } from "../src/core/session/message-types.js"

describe("TUI render helpers", () => {
  it("parses slash commands and prompts", () => {
    expect(parseTuiCommand("hello")).toEqual({ type: "prompt", prompt: "hello" })
    expect(parseTuiCommand("/help")).toEqual({ type: "help" })
    expect(parseTuiCommand("/use ses_123")).toEqual({ type: "use", sessionId: "ses_123" })
    expect(parseTuiCommand("/status")).toEqual({ type: "status" })
    expect(parseTuiCommand("/clear")).toEqual({ type: "clear" })
    expect(parseTuiCommand("/resume")).toEqual({ type: "sessions" })
    expect(parseTuiCommand("/model")).toEqual({ type: "models" })
    expect(parseTuiCommand("/diff")).toEqual({ type: "diff" })
    expect(parseTuiCommand("/revert")).toEqual({ type: "revert" })
    expect(parseTuiCommand("/abort")).toEqual({ type: "abort" })
    expect(parseTuiCommand("/exit")).toEqual({ type: "exit" })
    expect(parseTuiCommand("/connect")).toEqual({ type: "connect" })
    expect(parseTuiCommand("/switch gpt-4o")).toEqual({ type: "switch", ref: "gpt-4o" })
    expect(parseTuiCommand("/switch anthropic/claude-opus-4-8")).toEqual({ type: "switch", ref: "anthropic/claude-opus-4-8" })
    expect(parseTuiCommand("/switch")).toEqual({ type: "switch", ref: "" })
    expect(parseTuiCommand("   ")).toEqual({ type: "empty" })
  })

  it("suggests slash commands for prompt dropdown", () => {
    expect(suggestSlashCommands("/s").map((item) => item.command)).toEqual(["/sessions", "/status", "/switch <model>"])

    const output = stripAnsi(renderSlashCommandMenu("/st", 0).join("\n"))

    expect(output).toContain("commands")
    expect(output).toContain("/status")
    expect(output).toContain("Show runtime status")
  })

  it("marks the active session in session list output", () => {
    const sessions: Session[] = [
      session("ses_a", "idle"),
      session("ses_b", "running"),
    ]

    const output = renderSessionList(sessions, "ses_b")

    const plain = stripAnsi(output)
    expect(plain).toContain("Sessions")
    expect(plain).toContain("ses_a")
    expect(plain).toContain("idle")
    expect(plain).toContain("*")
    expect(plain).toContain("ses_b")
    expect(plain).toContain("running")
  })

  it("renders permission request details", () => {
    const output = renderPermissionRequest({
      id: "perm_123",
      status: "pending",
      createdAt: "2026-06-15T00:00:00.000Z",
      expiresAt: "2026-06-15T00:00:30.000Z",
      request: {
        sessionId: "ses_123",
        agentId: "default",
        action: "edit",
        resources: ["sample.txt"],
        source: {
          type: "tool",
          toolCallId: "tool_123",
        },
      },
    } satisfies PendingApproval)

    const plain = stripAnsi(output)
    expect(plain).toContain("Permission Requested")
    expect(plain).toContain("perm_123")
    expect(plain).toContain("action")
    expect(plain).toContain("edit")
    expect(plain).toContain("sample.txt")
  })

  it("renders status panel with model and permission modes", () => {
    const config = testConfig()

    const output = stripAnsi(renderStatusPanel(config, session("ses_status", "idle"), process.cwd(), 2))

    expect(output).toContain("ses_status")
    expect(output).toContain("mock/mock-agent")
    expect(output).toContain("shell=ask")
    expect(output).toContain("2 approvals")
  })

  it("renders the empty TUI as the normal workspace layout", () => {
    const config = testConfig()
    const output = stripAnsi(renderWelcome(config, session("ses_empty", "idle"), process.cwd(), 128))
    const firstLine = output.split("\n")[0] ?? ""

    expect(firstLine).toContain("agent-cli")
    expect(output).toContain("Context")
    expect(output).toContain("Usage")
    expect(output).not.toContain("Ask anything")
    expect(output).not.toContain("Dangerous shell/edit")
    expect(output).not.toContain("No messages yet")
  })

  it("renders a wide opencode-style context sidebar", () => {
    const config = testConfig()
    const output = stripAnsi(renderScreen({
      config,
      session: session("ses_sidebar", "idle"),
      messages: [
        message("msg_user", "user", "please read package.json"),
        {
          ...message("msg_assistant", "assistant", "I will read package.json."),
          usage: { inputTokens: 42, outputTokens: 12, totalTokens: 54 },
          parts: [
            { type: "text", text: "I will read package.json." },
            { type: "tool_call", toolCallId: "tool_1", name: "read_file", input: { path: "package.json" } },
          ],
        },
        {
          ...message("msg_tool", "tool", ""),
          parts: [
            { type: "tool_result", toolCallId: "tool_1", name: "read_file", output: "package contents" },
          ],
        },
      ],
      cwd: process.cwd(),
      pendingApprovals: 1,
      width: 128,
      height: 32,
    }))

    expect(output).toContain("Context")
    expect(output).toContain("Model")
    expect(output).toContain("mock/mock-agent")
    expect(output).toContain("Usage")
    expect(output).toContain("42 tok")
    expect(output).toContain("12 tok")
    expect(output).toContain("54 tok")
    expect(output).not.toContain("42 tok est")
    expect(output).toContain("Tools")
    expect(output).toContain("1")
  })

  it("keeps the wide workspace inside the terminal frame", () => {
    const config = testConfig()
    const height = 32
    const output = renderScreen({
      config,
      session: session("ses_frame", "idle"),
      messages: [message("msg_user", "user", "short prompt")],
      cwd: process.cwd(),
      width: 128,
      height,
    })

    expect(output.split("\n").length).toBeLessThanOrEqual(height - 4)
  })

  it("clips long notices without pushing the prompt area off-screen", () => {
    const config = testConfig()
    const height = 20
    const messages = Array.from({ length: 12 }, (_, index) => {
      const number = String(index + 1).padStart(3, "0")
      return message(`msg_${number}`, index % 2 === 0 ? "user" : "assistant", `entry-${number}`)
    })
    const output = stripAnsi(renderScreen({
      config,
      session: session("ses_notice", "idle"),
      messages,
      cwd: process.cwd(),
      notice: "notice ".repeat(120),
      width: 80,
      height,
    }))

    expect(output.split("\n").length).toBeLessThanOrEqual(height - 4)
    expect(output).toContain("more lines")
    expect(getTranscriptScrollMax(messages, 80, height, "notice ".repeat(120))).toBeGreaterThan(
      getTranscriptScrollMax(messages, 80, height),
    )
  })

  it("renders an older transcript viewport when scrolled", () => {
    const config = testConfig()
    const messages = Array.from({ length: 12 }, (_, index) => {
      const number = String(index + 1).padStart(3, "0")
      return message(`msg_${number}`, index % 2 === 0 ? "user" : "assistant", `entry-${number}`)
    })

    expect(getTranscriptScrollMax(messages, 80, 20)).toBeGreaterThan(0)

    const bottom = stripAnsi(renderScreen({
      config,
      session: session("ses_scroll", "idle"),
      messages,
      cwd: process.cwd(),
      width: 80,
      height: 20,
      scrollOffset: 0,
    }))
    const scrolled = stripAnsi(renderScreen({
      config,
      session: session("ses_scroll", "idle"),
      messages,
      cwd: process.cwd(),
      width: 80,
      height: 20,
      scrollOffset: 1_000,
    }))

    expect(bottom).toContain("entry-012")
    expect(bottom).not.toContain("entry-001")
    expect(scrolled).toContain("entry-001")
    expect(scrolled).not.toContain("entry-012")
  })
})

function session(id: string, status: Session["status"]): Session {
  return {
    id,
    status,
    cwd: process.cwd(),
    model: { provider: "mock", model: "mock-agent" },
    agentId: "default",
    mode: "build",
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
  }
}

function message(id: string, role: Message["role"], text: string): Message {
  return {
    id,
    sessionId: "ses_sidebar",
    role,
    parts: text ? [{ type: "text", text }] : [],
    createdAt: "2026-06-15T00:00:00.000Z",
  }
}

function testConfig(): AppConfig {
  return {
    ...defaultConfig,
    storage: { kind: "memory", path: ".agent-cli/sessions.json", dbPath: ".agent-cli/agent.db" },
    permissions: {
      ...defaultConfig.permissions,
      allowShell: false,
      allowEdit: false,
      askForShell: true,
      askForEdit: true,
    },
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}
