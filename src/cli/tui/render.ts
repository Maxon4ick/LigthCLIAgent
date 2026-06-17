import type { AppConfig, ModelCatalogEntry, ModelRef } from "../../core/config/schema.js"
import type { PendingApproval } from "../../core/permissions/approvals.js"
import type { PublicFileSnapshotRecord, RevertSnapshotResult } from "../../core/session/file-snapshots.js"
import type { Message, Session } from "../../core/session/message-types.js"
import type { ToolExecution } from "../../core/tools/scheduler.js"
import type { PublicToolDefinition } from "../../core/tools/tool.js"

export type TuiCommand =
  | { type: "exit" }
  | { type: "help" }
  | { type: "new" }
  | { type: "clear" }
  | { type: "clear_history" }
  | { type: "forget" }
  | { type: "sessions" }
  | { type: "use"; sessionId: string }
  | { type: "history" }
  | { type: "config" }
  | { type: "status" }
  | { type: "tools" }
  | { type: "models" }
  | { type: "connect" }
  | { type: "switch"; ref: string }
  | { type: "diff" }
  | { type: "revert" }
  | { type: "abort" }
  | { type: "mode"; mode: "build" | "plan" | "explore" | "orchestrate" }
  | { type: "compact" }
  | { type: "fork" }
  | { type: "keys" }
  | { type: "key_add" }
  | { type: "key_delete" }
  | { type: "model_remove" }
  | { type: "copy" }
  | { type: "prompt"; prompt: string }
  | { type: "empty" }
  | { type: "unknown"; input: string }

export interface SlashCommandHint {
  command: string
  description: string
  insert: string
  aliases?: string[]
}

export const slashCommandHints: SlashCommandHint[] = [
  { command: "/help", description: "Show command palette", insert: "/help" },
  { command: "/new", description: "Create and switch session", insert: "/new" },
  { command: "/clear", description: "Redraw the TUI", insert: "/clear" },
  { command: "/clear-history", description: "Delete current transcript", insert: "/clear-history" },
  { command: "/forget", description: "Delete current session", insert: "/forget" },
  { command: "/sessions", description: "List sessions", insert: "/sessions", aliases: ["/resume", "/continue"] },
  { command: "/use <id>", description: "Switch session", insert: "/use " },
  { command: "/history", description: "Show current transcript", insert: "/history", aliases: ["/messages"] },
  { command: "/status", description: "Show runtime status", insert: "/status" },
  { command: "/config", description: "Show effective config", insert: "/config" },
  { command: "/tools", description: "List registered tools", insert: "/tools" },
  { command: "/models", description: "Show model catalog", insert: "/models" },
  { command: "/model", description: "Show active model", insert: "/model" },
  { command: "/connect", description: "Set provider, API key & model (persisted)", insert: "/connect" },
  { command: "/switch <model>", description: "Switch model (e.g. gpt-4o or anthropic/claude-3-5-sonnet)", insert: "/switch " },
  { command: "/diff", description: "Show edit snapshots", insert: "/diff" },
  { command: "/revert", description: "Revert current session edits", insert: "/revert" },
  { command: "/abort", description: "Cancel active run", insert: "/abort" },
  { command: "/mode build", description: "Switch to build mode", insert: "/mode build" },
  { command: "/mode plan", description: "Switch to planning mode", insert: "/mode plan" },
  { command: "/mode explore", description: "Switch to explore mode", insert: "/mode explore" },
  { command: "/mode orchestrate", description: "Switch to orchestrate mode", insert: "/mode orchestrate" },
  { command: "/compact", description: "Summarize and trim old transcript", insert: "/compact" },
  { command: "/fork", description: "Fork current session", insert: "/fork" },
  { command: "/keys", description: "List stored API keys", insert: "/keys" },
  { command: "/key-add", description: "Store or update an API key", insert: "/key-add" },
  { command: "/key-delete", description: "Delete a stored API key", insert: "/key-delete" },
  { command: "/model-remove", description: "Remove a custom model from the catalog", insert: "/model-remove" },
  { command: "/copy", description: "Enter copy/yank mode", insert: "/copy" },
  { command: "/exit", description: "Quit", insert: "/exit", aliases: ["/quit", "/q"] },
]

export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  inverse: "\x1b[7m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  clearScreen: "\x1b[2J\x1b[H",
  clearScrollback: "\x1b[3J",
  enterAlternateScreen: "\x1b[?1049h",
  exitAlternateScreen: "\x1b[?1049l",
  enableMouse: "\x1b[?1000h\x1b[?1006h",
  disableMouse: "\x1b[?1006l\x1b[?1000l",
  eraseLine: "\x1b[2K",
  fg(hex: string): string {
    const color = parseHexColor(hex)
    return `\x1b[38;2;${color.r};${color.g};${color.b}m`
  },
  bg(hex: string): string {
    const color = parseHexColor(hex)
    return `\x1b[48;2;${color.r};${color.g};${color.b}m`
  },
}

const palette = {
  primary: "#fab283",
  secondary: "#5c9cf5",
  accent: "#9d7cd8",
  error: "#e06c75",
  warning: "#f5a742",
  success: "#7fd88f",
  info: "#56b6c2",
  text: "#eeeeee",
  muted: "#808080",
  border: "#484848",
  panel: "#141414",
}

export function parseTuiCommand(input: string): TuiCommand {
  const trimmed = input.trim()
  if (!trimmed) return { type: "empty" }
  if (!trimmed.startsWith("/")) return { type: "prompt", prompt: trimmed }

  const [command = "", ...rest] = trimmed.slice(1).split(/\s+/)
  if (command === "exit" || command === "quit" || command === "q") return { type: "exit" }
  if (command === "help" || command === "h") return { type: "help" }
  if (command === "new") return { type: "new" }
  if (command === "clear") return { type: "clear" }
  if (command === "clear-history") return { type: "clear_history" }
  if (command === "forget") return { type: "forget" }
  if (command === "sessions" || command === "resume" || command === "continue") return { type: "sessions" }
  if (command === "history" || command === "messages") return { type: "history" }
  if (command === "config") return { type: "config" }
  if (command === "status") return { type: "status" }
  if (command === "tools") return { type: "tools" }
  if (command === "models" || command === "model") return { type: "models" }
  if (command === "connect") return { type: "connect" }
  if (command === "switch") return { type: "switch", ref: rest[0] ?? "" }
  if (command === "diff") return { type: "diff" }
  if (command === "revert") return { type: "revert" }
  if (command === "abort") return { type: "abort" }
  if (command === "compact") return { type: "compact" }
  if (command === "fork") return { type: "fork" }
  if (command === "keys") return { type: "keys" }
  if (command === "key-add" || command === "key-set") return { type: "key_add" }
  if (command === "key-delete" || command === "key-remove") return { type: "key_delete" }
  if (command === "model-remove" || command === "model-delete") return { type: "model_remove" }
  if (command === "mode" && (rest[0] === "build" || rest[0] === "plan" || rest[0] === "explore" || rest[0] === "orchestrate")) {
    return { type: "mode", mode: rest[0] }
  }
  if (command === "use" && rest[0]) return { type: "use", sessionId: rest[0] }
  if (command === "copy" || command === "yank") return { type: "copy" }
  return { type: "unknown", input: trimmed }
}

export function suggestSlashCommands(input: string, hints: SlashCommandHint[] = slashCommandHints): SlashCommandHint[] {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith("/")) return []

  const query = trimmed.toLowerCase()
  return hints
    .filter((hint) => {
      const values = [hint.command, hint.insert, ...(hint.aliases ?? [])].map((value) => value.toLowerCase())
      return values.some((value) => value.startsWith(query) || value.replace(/[ <].*$/, "").startsWith(query))
    })
    .slice(0, 7)
}

export function renderSlashCommandMenu(input: string, selectedIndex: number, width = 72): string[] {
  const suggestions = suggestSlashCommands(input)
  if (suggestions.length === 0) return []

  const menuWidth = Math.max(34, Math.min(width, 72))
  const innerWidth = menuWidth - 4
  const border = `${color("+", palette.border)}${color("-".repeat(innerWidth + 2), palette.border)}${color("+", palette.border)}`
  const title = `${color("|", palette.border)} ${ansi.dim}commands${ansi.reset}${" ".repeat(Math.max(0, innerWidth - "commands".length))} ${color("|", palette.border)}`
  const rows = suggestions.map((hint, index) => {
    const marker = index === selectedIndex ? ">" : " "
    const command = hint.command.padEnd(12)
    const text = `${marker} ${command} ${hint.description}`
    const content = truncatePlain(text, innerWidth)
    const decorated = index === selectedIndex
      ? `${ansi.inverse}${content}${ansi.reset}`
      : `${color(marker, palette.muted)} ${color(command, palette.primary)} ${hint.description}`
    return `${color("|", palette.border)} ${padVisible(decorated, innerWidth)} ${color("|", palette.border)}`
  })

  return [border, title, ...rows, border]
}

export function renderHeader(config: AppConfig, session: Session): string {
  return renderShellHeader({
    title: "agent-cli",
    subtitle: "terminal agent workspace",
    session,
    config,
    cwd: session.cwd,
    width: 96,
  })
}

export function renderHelp(width = 88): string {
  const rows = [
    ["/help", "Show this help"],
    ["/new", "Create and switch to a new session"],
    ["/clear", "Redraw the TUI"],
    ["/clear-history", "Delete current transcript"],
    ["/forget", "Delete current session"],
    ["/sessions", "List sessions"],
    ["/use <id>", "Switch session"],
    ["/history", "Show current session messages"],
    ["/status", "Show runtime status"],
    ["/config", "Show effective config summary"],
    ["/tools", "List registered tools"],
    ["/model", "Show active model and catalog"],
    ["/connect", "Set provider, API key & model — saved for all sessions"],
    ["/switch <model>", "Switch model live (e.g. gpt-4o or anthropic/claude-3-5)"],
    ["/diff", "Show edit snapshots for current session"],
    ["/revert", "Revert edit snapshots for current session"],
    ["/abort", "Cancel active run"],
    ["/mode <build|plan|explore|orchestrate>", "Switch agent mode"],
    ["/compact", "Summarize and trim old transcript"],
    ["/fork", "Fork current session"],
    ["/keys", "List stored API keys"],
    ["/key-add", "Store or update an API key"],
    ["/key-delete", "Delete a stored API key"],
    ["/model-remove", "Remove a custom model from the catalog"],
    ["/copy", "Enter copy/yank mode — navigate lines, select range, copy to clipboard"],
    ["/exit", "Quit"],
  ]

  return renderPanel(
    "Command Palette",
    [
      ...rows.map(([command, description]) => `${color(command.padEnd(14), palette.primary)} ${description}`),
      "",
      `${ansi.dim}Anything else is sent as a prompt. Shell/edit tools ask inline unless explicitly allowed.${ansi.reset}`,
      `${ansi.dim}Scroll wheel scrolls the transcript. Hold Shift and drag to select text with the mouse.${ansi.reset}`,
    ],
    width,
  )
}

export function renderSessionList(sessions: Session[], activeSessionId: string, width = 110): string {
  if (sessions.length === 0) return renderPanel("Sessions", ["No sessions."], width)

  const lines = sessions.map((session, index) => {
    const marker = session.id === activeSessionId ? color("*", palette.primary) : ansi.dim + " " + ansi.reset
    const slot = color(String(index + 1).padStart(2), palette.muted)
    const status = colorStatus(session.status)
    const model = `${session.model.provider}/${session.model.model}`
    return `${marker} ${slot} ${session.id.padEnd(16)} ${status.padEnd(18)} ${color(session.mode.padEnd(8), palette.info)} ${color(model, palette.secondary)} ${ansi.dim}${session.updatedAt}${ansi.reset}`
  })

  return renderPanel("Sessions", lines, width)
}

export function renderHistory(messages: Message[], width = 100): string {
  if (messages.length === 0) return renderPanel("Transcript", ["No messages in this session."], 88)

  return renderTranscript(messages, width)
}

export function renderConfigSummary(config: AppConfig, width = 100): string {
  const summary = JSON.stringify(
    {
      model: config.model,
      provider: {
        openaiCompatible: {
          baseUrl: config.providers.openaiCompatible.baseUrl,
          apiKeyEnv: config.providers.openaiCompatible.apiKeyEnv,
          hasApiKey: Boolean(config.providers.openaiCompatible.apiKey),
        },
        anthropic: {
          baseUrl: config.providers.anthropic.baseUrl,
          apiKeyEnv: config.providers.anthropic.apiKeyEnv,
          hasApiKey: Boolean(config.providers.anthropic.apiKey),
        },
        gemini: {
          baseUrl: config.providers.gemini.baseUrl,
          apiKeyEnv: config.providers.gemini.apiKeyEnv,
          hasApiKey: Boolean(config.providers.gemini.apiKey),
        },
      },
      models: config.models,
      storage: config.storage,
      permissions: config.permissions,
      tools: config.tools,
      agent: config.agent,
      audit: config.audit,
      toolOutput: config.toolOutput,
    },
    null,
    2,
  )

  return renderPanel("Config", summary.split("\n"), width)
}

export function renderToolResult(result: ToolExecution): string {
  if (!result.ok) {
    return renderToolLine("x", result.name, result.error ?? "unknown error", "failed")
  }

  const output = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)
  return renderToolLine("ok", result.name, output ?? "", "ok")
}

export function renderPermissionRequest(approval: PendingApproval): string {
  const request = approval.request
  return renderPanel(
    "Permission Requested",
    [
      `${color("id", palette.muted)}        ${approval.id}`,
      `${color("action", palette.muted)}    ${request.action}`,
      `${color("resources", palette.muted)} ${request.resources.join(", ") || "unknown"}`,
      `${color("toolCall", palette.muted)}  ${request.source.toolCallId}`,
      `${color("expires", palette.muted)}   ${approval.expiresAt}`,
    ],
    86,
    "warning",
  )
}

export interface TuiScreenSnapshot {
  config: AppConfig
  session: Session
  messages: Message[]
  cwd: string
  notice?: string
  pendingApprovals?: number
  panel?: string
  scrollOffset?: number
  width?: number
  height?: number
}

export function renderWelcome(config: AppConfig, session: Session, cwd: string, width = 96): string {
  return renderScreen({
    config,
    session,
    messages: [],
    cwd,
    width,
  })
}

export function renderScreen(snapshot: TuiScreenSnapshot): string {
  const width = snapshot.width ?? 96
  const height = snapshot.height ?? 32
  const notice = noticeLinesForScreen(snapshot.notice, width, height)
  const { transcriptHeight, sidebar, sidebarWidth, gutter, contentWidth } = screenLayout(width, height, notice.length)
  const transcriptSource = snapshot.panel
    ? fitBlock(snapshot.panel.split("\n"), contentWidth, transcriptHeight)
    : snapshot.messages.length === 0
    ? emptyTranscript(transcriptHeight)
    : transcriptWindow(renderTranscript(snapshot.messages, contentWidth).split("\n"), transcriptHeight, snapshot.scrollOffset ?? 0)
  const transcript = padLines(transcriptSource, transcriptHeight)
  const body = sidebar
    ? joinColumns(transcript, renderSidebar(snapshot, sidebarWidth), contentWidth, sidebarWidth, gutter, transcriptHeight)
    : transcript

  return [
    renderShellHeader({
      title: "agent-cli",
      subtitle: "opencode-inspired terminal workspace",
      session: snapshot.session,
      config: snapshot.config,
      cwd: snapshot.cwd,
      width,
    }),
    "",
    ...body,
    ...notice,
    "",
    renderFooter(snapshot, width),
  ].join("\n")
}

export function getTranscriptScrollMax(messages: Message[], width = 96, height = 32, notice?: string): number {
  if (messages.length === 0) return 0
  const noticeRows = noticeLinesForScreen(notice, width, height).length
  const { contentWidth, transcriptHeight } = screenLayout(width, height, noticeRows)
  const lines = renderTranscript(messages, contentWidth).split("\n")
  return Math.max(0, lines.length - transcriptHeight)
}

export function renderStatusPanel(config: AppConfig, session: Session, cwd: string, pendingApprovals = 0, width = 100): string {
  return renderPanel(
    "Status",
    [
      `${color("session", palette.muted)}     ${session.id}`,
      `${color("state", palette.muted)}       ${session.status}`,
      `${color("model", palette.muted)}       ${session.model.provider}/${session.model.model}`,
      `${color("agent", palette.muted)}       ${session.agentId}`,
      `${color("mode", palette.muted)}        ${session.mode}`,
      `${color("cwd", palette.muted)}         ${cwd}`,
      `${color("storage", palette.muted)}     ${config.storage.kind} (${config.storage.path})`,
      `${color("permissions", palette.muted)} shell=${permissionMode(config.permissions.allowShell, config.permissions.askForShell)} edit=${permissionMode(config.permissions.allowEdit, config.permissions.askForEdit)} network=${permissionMode(config.permissions.allowNetwork, config.permissions.askForNetwork)}`,
      `${color("pending", palette.muted)}     ${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"}`,
    ],
    width,
  )
}

export function renderPrompt(session: Session): string {
  const status = session.status === "running" ? color("running", palette.warning) : color("ready", palette.success)
  return `${ansi.bold}${color(">", palette.primary)}${ansi.reset} ${ansi.dim}${session.id} ${status}${ansi.reset} `
}

export function renderUserPrompt(prompt: string, width = 96): string {
  return renderMessageBlock("user", prompt, new Date().toISOString(), width)
}

export function renderAssistantPrefix(): string {
  return `${roleBadge("assistant")} `
}

export function renderToolCall(name: string, input: unknown): string {
  return renderToolLine(">", name, summarizeValue(input), "running")
}

export function renderRunError(error: unknown): string {
  return renderNotice(error instanceof Error ? error.message : String(error), 96, "error")
}

export function renderToolsPanel(tools: PublicToolDefinition[], width = 100): string {
  if (tools.length === 0) return renderPanel("Tools", ["No tools registered."], width)

  const lines = tools.map((tool) => {
    const approval = tool.metadata.requiresApproval ? color("!", palette.warning) : color("*", palette.success)
    const name = color(tool.name.padEnd(26), palette.primary)
    const kind = color(tool.kind.padEnd(8), palette.info)
    const desc = truncatePlain(tool.description, Math.max(20, width - 46))
    return `${approval} ${name} ${kind} ${ansi.dim}${desc}${ansi.reset}`
  })

  return renderPanel(`Tools (${tools.length})`, lines, width)
}

export function renderKeysPanel(entries: { provider: string; updatedAt: string }[], width = 100): string {
  if (entries.length === 0) {
    return renderPanel("API Keys", ["No stored API keys.  Use /key-add to store one."], width)
  }

  const lines = entries.map((entry) => {
    const provider = color(entry.provider.padEnd(24), palette.primary)
    return `  ${provider} ${ansi.dim}updated ${entry.updatedAt}${ansi.reset}`
  })

  return renderPanel(`API Keys (${entries.length})`, lines, width)
}

export function renderModelsPanel(catalog: ModelCatalogEntry[], activeModel: ModelRef, width = 100): string {
  if (catalog.length === 0) return renderPanel("Models", ["No models in catalog."], width)

  const lines = catalog.map((entry) => {
    const isActive = entry.provider === activeModel.provider && entry.model === activeModel.model
    const marker = isActive ? color("*", palette.primary) : " "
    const ref = `${entry.provider}/${entry.model}`
    const caps: string[] = []
    if (entry.capabilities.tools) caps.push("tools")
    if (entry.capabilities.streaming) caps.push("stream")
    if (entry.capabilities.reasoning) caps.push("reason")
    if (entry.capabilities.imageInput) caps.push("vision")
    const proto = color(entry.protocol.padEnd(22), palette.secondary)
    const capStr = color(caps.join(" "), palette.info)
    const styledRef = isActive ? `${ansi.bold}${color(ref, palette.primary)}${ansi.reset}` : color(ref, palette.text)
    return `${marker} ${padVisible(styledRef, 40)} ${proto} ${capStr}`
  })

  return renderPanel(`Models (${catalog.length})`, lines, width)
}

export function renderConnectPanel(
  current: { provider: string; baseUrl?: string; model: string; hasKey: boolean },
  width = 100,
): string {
  const keyStatus = current.hasKey ? color("set", palette.success) : color("not set", palette.error)
  const lines = [
    `${color("provider", palette.muted)}  ${color(current.provider, palette.primary)}`,
    ...(current.baseUrl ? [`${color("base url", palette.muted)}  ${current.baseUrl}`] : []),
    `${color("api key", palette.muted)}   ${keyStatus}`,
    `${color("model", palette.muted)}     ${current.model}`,
    "",
    `${ansi.dim}Supports any provider: anthropic, gemini, openai-compatible, or a custom name.${ansi.reset}`,
    `${ansi.dim}API key and model are saved to SQLite — available across all sessions.${ansi.reset}`,
    `${ansi.dim}Press Enter to keep the current value shown in brackets.${ansi.reset}`,
  ]
  return renderPanel("Connect — provider, API key & model", lines, width)
}

export function renderSwitchPanel(catalog: ModelCatalogEntry[], activeModel: ModelRef, width = 100): string {
  const lines = catalog.map((entry) => {
    const isActive = entry.provider === activeModel.provider && entry.model === activeModel.model
    const marker = isActive ? color("*", palette.primary) : " "
    const ref = `${entry.provider}/${entry.model}`
    return `${marker} ${color(ref, isActive ? palette.primary : palette.text)}`
  })
  return renderPanel(
    "Switch Model — type /switch <provider/model>",
    [
      ...lines,
      "",
      `${ansi.dim}Examples: ${color("/switch gpt-4o", palette.secondary)}  ${color("/switch anthropic/claude-opus-4-8", palette.secondary)}${ansi.reset}`,
    ],
    width,
  )
}

export function renderModelPickerMenu(
  catalog: ModelCatalogEntry[],
  activeModel: ModelRef,
  query: string,
  selectedIndex: number,
  width = 72,
): string[] {
  const filtered = query.trim()
    ? catalog.filter((e) => `${e.provider}/${e.model}`.toLowerCase().includes(query.trim().toLowerCase()))
    : catalog

  const menuWidth = Math.max(34, Math.min(width, 72))
  const innerWidth = menuWidth - 4
  const border = `${color("+", palette.border)}${color("-".repeat(innerWidth + 2), palette.border)}${color("+", palette.border)}`
  const title = `${color("|", palette.border)} ${ansi.dim}switch model${ansi.reset}${" ".repeat(Math.max(0, innerWidth - "switch model".length))} ${color("|", palette.border)}`

  if (filtered.length === 0) {
    const noMatch = `${color("|", palette.border)} ${color("no matches", palette.muted)}${" ".repeat(Math.max(0, innerWidth - "no matches".length))} ${color("|", palette.border)}`
    return [border, title, noMatch, border]
  }

  const rows = filtered.map((entry, index) => {
    const isActive = entry.provider === activeModel.provider && entry.model === activeModel.model
    const isSelected = index === selectedIndex
    const ref = `${entry.provider}/${entry.model}`
    const marker = isSelected ? ">" : (isActive ? "*" : " ")
    const text = `${marker} ${ref}`
    const content = truncatePlain(text, innerWidth)
    const decorated = isSelected
      ? `${ansi.inverse}${content}${ansi.reset}`
      : isActive
      ? `${color(marker, palette.primary)} ${color(ref, palette.primary)}`
      : `${color(marker, palette.muted)} ${color(ref, palette.text)}`
    return `${color("|", palette.border)} ${padVisible(decorated, innerWidth)} ${color("|", palette.border)}`
  })

  return [border, title, ...rows, border]
}

export function renderDiffPanel(snapshots: PublicFileSnapshotRecord[], width = 100): string {
  if (snapshots.length === 0) return renderPanel("Edit Snapshots", ["No snapshots for this session."], width)

  const lines = snapshots.map((snap) => {
    const id = color(snap.id.slice(0, 12), palette.muted)
    const action = color(snap.action.padEnd(7), snap.action === "write" ? palette.warning : palette.info)
    const filePath = truncatePlain(snap.path, Math.max(20, width - 26))
    return `${id} ${action} ${filePath}`
  })

  return renderPanel(`Edit Snapshots (${snapshots.length})`, lines, width)
}

export function renderRevertPanel(results: RevertSnapshotResult[], width = 100): string {
  if (results.length === 0) return renderPanel("Revert", ["Nothing to revert."], width)

  const lines = results.map((result) => {
    const icon = result.reverted ? color("*", palette.success) : color("-", palette.muted)
    const filePath = truncatePlain(result.snapshot.path, Math.max(20, width - 24))
    const note = result.skipped ? ` ${ansi.dim}${result.skipped}${ansi.reset}` : ""
    return `${icon} ${filePath}${note}`
  })

  const count = results.filter((r) => r.reverted).length
  return renderPanel(`Reverted ${count} of ${results.length}`, lines, width)
}

export interface CopyModeLine {
  plain: string
  styled: string
}

export function extractCopyLines(messages: Message[], width: number): CopyModeLine[] {
  if (messages.length === 0) return []
  return renderTranscript(messages, Math.max(24, width - 4))
    .split("\n")
    .map((line) => ({ plain: stripAnsi(line), styled: line }))
}

export function renderCopyModeScreen(
  snapshot: TuiScreenSnapshot,
  lines: CopyModeLine[],
  cursor: number,
  selectionStart: number | undefined,
  viewOffset: number,
): string {
  const width = snapshot.width ?? 96
  const height = snapshot.height ?? 32
  const bodyHeight = Math.max(8, height - 8)
  const selMin = selectionStart !== undefined ? Math.min(selectionStart, cursor) : 0
  const selMax = selectionStart !== undefined ? Math.max(selectionStart, cursor) : 0
  const maxOffset = Math.max(0, lines.length - bodyHeight)
  const offset = Math.min(Math.max(0, viewOffset), maxOffset)

  const body: string[] = lines.slice(offset, offset + bodyHeight).map((line, i) => {
    const idx = i + offset
    const inSelection = selectionStart !== undefined && idx >= selMin && idx <= selMax
    const isCursor = idx === cursor
    const plain = line.plain
    if (inSelection) {
      return `${ansi.bg("#1e3a5f")}${plain}${" ".repeat(Math.max(0, width - plain.length))}${ansi.reset}`
    }
    if (isCursor) {
      return `${ansi.inverse}${plain}${ansi.reset}`
    }
    return line.styled
  })
  while (body.length < bodyHeight) body.push("")

  const selCount = selectionStart !== undefined ? Math.abs(cursor - selectionStart) + 1 : 0
  const hint = selectionStart !== undefined
    ? `COPY  ${selCount} line${selCount === 1 ? "" : "s"} selected  [y] copy  [v] clear selection  [q] cancel`
    : `COPY  line ${cursor + 1}/${lines.length}  [v] select  [y] yank line  [j/k ↑/↓] navigate  [q] quit`

  return [
    renderShellHeader({
      title: "agent-cli",
      subtitle: "copy mode",
      session: snapshot.session,
      config: snapshot.config,
      cwd: snapshot.cwd,
      width,
    }),
    "",
    ...body,
    "",
    `${ansi.dim}${truncatePlain(hint, width)}${ansi.reset}`,
  ].join("\n")
}

function renderShellHeader(input: {
  title: string
  subtitle: string
  session: Session
  config: AppConfig
  cwd: string
  width: number
}): string {
  const title = `${ansi.bold}${color(input.title, palette.primary)}${ansi.reset} ${ansi.dim}${input.subtitle}${ansi.reset}`
  const right = `${colorStatus(input.session.status)} ${ansi.dim}${input.session.model.provider}/${input.session.model.model}${ansi.reset}`
  const line = fitColumns(title, right, input.width)
  const meta = [
    `session ${input.session.id}`,
    `${input.config.storage.kind} storage`,
    trimMiddle(input.cwd, Math.max(18, input.width - 48)),
  ].join("  ")

  return [
    line,
    `${ansi.dim}${truncatePlain(meta, input.width)}${ansi.reset}`,
    color(horizontalRule(input.width), palette.border),
  ].join("\n")
}

function renderTranscript(messages: Message[], width: number): string {
  return messages
    .map((message) => {
      const body = message.parts.flatMap((part) => {
        if (part.type === "text") return wrapPlain(part.text || "(empty)", Math.max(24, width - 4))
        if (part.type === "tool_call") return [renderToolCall(part.name, part.input)]
        return [renderToolResult({
          toolCallId: part.toolCallId,
          name: part.name,
          ok: !part.error,
          output: part.output,
          error: part.error,
        })]
      })
      return renderMessageBlock(message.role, body.join("\n"), message.createdAt, width)
    })
    .join("\n\n")
}

function renderMessageBlock(role: Message["role"], text: string, createdAt: string, width: number): string {
  const bodyWidth = Math.max(24, width - 4)
  const body = text.split("\n").flatMap((line) => wrapPlain(line, bodyWidth))
  const label = `${roleBadge(role)} ${ansi.dim}${formatTime(createdAt)}${ansi.reset}`
  return [label, ...body.map((line) => `  ${line}`)].join("\n")
}

function renderPanel(title: string, lines: string[], width: number, variant: "normal" | "warning" = "normal"): string {
  const borderColor = variant === "warning" ? palette.warning : palette.border
  const innerWidth = Math.max(24, width - 4)
  const top = `${color("+", borderColor)}${color("-".repeat(innerWidth + 2), borderColor)}${color("+", borderColor)}`
  const titleLine = `| ${ansi.bold}${title}${ansi.reset}${" ".repeat(Math.max(0, innerWidth - visibleLength(title)))} |`
  const body = lines.flatMap((line) => wrapAnsiLine(line, innerWidth)).map((line) => {
    const padding = Math.max(0, innerWidth - visibleLength(line))
    return `${color("|", borderColor)} ${line}${" ".repeat(padding)} ${color("|", borderColor)}`
  })
  const bottom = top
  return [top, titleLine, ...body, bottom].join("\n")
}

function renderSidebar(snapshot: TuiScreenSnapshot, width: number): string[] {
  const stats = sessionStats(snapshot.messages)
  const permissions = `${permissionMode(snapshot.config.permissions.allowShell, snapshot.config.permissions.askForShell)}/${permissionMode(snapshot.config.permissions.allowEdit, snapshot.config.permissions.askForEdit)}/${permissionMode(snapshot.config.permissions.allowNetwork, snapshot.config.permissions.askForNetwork)}`
  const model = `${snapshot.session.model.provider}/${snapshot.session.model.model}`
  const usageLines = [
    sidebarRow("Model", model, width),
    sidebarRow("State", snapshot.session.status, width),
    sidebarRow("Agent", snapshot.session.agentId, width),
    sidebarRow("Mode", snapshot.session.mode, width),
    sidebarRow("Storage", snapshot.config.storage.kind, width),
    sidebarRow("Perms", permissions, width),
    "",
    color("Usage", palette.primary),
    sidebarRow("Input", formatTokens(stats.inputTokens, stats.estimated), width),
    sidebarRow("Output", formatTokens(stats.outputTokens, stats.estimated), width),
    sidebarRow("Total", formatTokens(stats.totalTokens, stats.estimated), width),
    sidebarRow("Messages", String(stats.messages), width),
    sidebarRow("Tools", `${stats.toolCalls}/${stats.toolResults}`, width),
    sidebarRow("Failed", String(stats.failedTools), width),
    sidebarRow("Approvals", String(snapshot.pendingApprovals ?? 0), width),
    "",
    color("Workspace", palette.primary),
    trimMiddle(snapshot.cwd, Math.max(12, width - 4)),
    "",
    color("Commands", palette.primary),
    `${color("/status", palette.secondary)} runtime details`,
    `${color("/sessions", palette.secondary)} switch thread`,
    `${color("/new", palette.secondary)} fresh thread`,
  ]

  return renderPanel("Context", usageLines, width).split("\n")
}

function sidebarRow(label: string, value: string, width: number): string {
  const inner = Math.max(20, width - 6)
  const labelWidth = Math.min(9, Math.max(6, Math.floor(inner * 0.36)))
  const available = Math.max(6, inner - labelWidth - 1)
  return `${color(label.padEnd(labelWidth), palette.muted)} ${truncatePlain(value, available)}`
}

function formatTokens(tokens: number, estimated: boolean): string {
  return `${tokens} tok${estimated ? " est" : ""}`
}

function renderFooter(snapshot: TuiScreenSnapshot, width: number): string {
  const permissions = `shell=${permissionMode(snapshot.config.permissions.allowShell, snapshot.config.permissions.askForShell)} edit=${permissionMode(snapshot.config.permissions.allowEdit, snapshot.config.permissions.askForEdit)} net=${permissionMode(snapshot.config.permissions.allowNetwork, snapshot.config.permissions.askForNetwork)}`
  const approvalText = snapshot.pendingApprovals ? color(`${snapshot.pendingApprovals} pending`, palette.warning) : color("no pending approvals", palette.muted)
  const left = `${trimMiddle(snapshot.cwd, Math.max(12, Math.floor(width * 0.42)))}`
  const right = `${snapshot.session.model.model}  ${permissions}  ${approvalText}  ${color("/help", palette.primary)}`
  return `${ansi.dim}${fitColumns(left, right, width)}${ansi.reset}`
}

function renderNotice(message: string, width: number, variant: "info" | "error" = "info"): string {
  const prefix = variant === "error" ? "error" : "note"
  const colorHex = variant === "error" ? palette.error : palette.info
  return wrapPlain(message, Math.max(20, width - prefix.length - 5))
    .map((line, index) => `${color(index === 0 ? prefix : " ".repeat(prefix.length), colorHex)}  ${line}`)
    .join("\n")
}

function renderToolLine(icon: string, name: string, detail: string, state: "running" | "ok" | "failed"): string {
  const iconColor = state === "failed" ? palette.error : state === "ok" ? palette.success : palette.warning
  const label = state === "running" ? "running" : state
  const preview = summarizeText(detail)
  return `${color(icon.padEnd(2), iconColor)} ${color(name, palette.secondary)} ${ansi.dim}${label}${ansi.reset}${preview ? ` ${preview}` : ""}`
}

function roleBadge(role: Message["role"]): string {
  const colorHex = role === "user" ? palette.primary : role === "assistant" ? palette.info : role === "tool" ? palette.success : palette.muted
  return `${ansi.bold}${color(role.padEnd(9), colorHex)}${ansi.reset}`
}

function colorStatus(status: Session["status"]): string {
  const colorHex = status === "idle" ? palette.success : status === "running" ? palette.warning : status === "error" ? palette.error : palette.muted
  return color(status, colorHex)
}

function permissionMode(allowed: boolean, asks: boolean): string {
  if (allowed) return "allow"
  if (asks) return "ask"
  return "deny"
}

function color(text: string, hex: string): string {
  return `${ansi.fg(hex)}${text}${ansi.reset}`
}

function horizontalRule(width: number): string {
  return "-".repeat(Math.max(24, width))
}

function center(text: string, width: number): string {
  const padding = Math.max(0, Math.floor((width - visibleLength(text)) / 2))
  return `${" ".repeat(padding)}${text}`
}

function fitColumns(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right))
  if (gap > 1) return `${left}${" ".repeat(gap)}${right}`
  const available = Math.max(8, width - visibleLength(right) - 2)
  return `${truncateAnsi(left, available)}  ${right}`
}

function joinColumns(
  left: string[],
  right: string[],
  leftWidth: number,
  rightWidth: number,
  gutter: number,
  maxLines: number,
): string[] {
  const rows = maxLines
  const lines: string[] = []
  for (let index = 0; index < rows; index += 1) {
    const leftLine = left[index] ?? ""
    const rightLine = right[index] ?? ""
    lines.push(`${padAnsi(leftLine, leftWidth)}${" ".repeat(gutter)}${padAnsi(rightLine, rightWidth)}`)
  }
  return lines
}

function screenLayout(width: number, height: number, reservedRows = 0): {
  transcriptHeight: number
  sidebar: boolean
  sidebarWidth: number
  gutter: number
  contentWidth: number
} {
  const minTranscriptHeight = reservedRows > 0 ? 4 : 8
  const transcriptHeight = Math.max(minTranscriptHeight, height - 10 - reservedRows)
  const sidebar = shouldShowSidebar(width)
  const sidebarWidth = sidebar ? Math.min(36, Math.max(30, Math.floor(width * 0.34))) : 0
  const gutter = sidebar ? 2 : 0
  const contentWidth = sidebar ? Math.max(42, width - sidebarWidth - gutter) : width
  return { transcriptHeight, sidebar, sidebarWidth, gutter, contentWidth }
}

function transcriptWindow(lines: string[], maxLines: number, scrollOffset: number): string[] {
  if (lines.length <= maxLines) return lines
  const maxOffset = lines.length - maxLines
  const clampedOffset = Math.min(Math.max(0, Math.floor(scrollOffset)), maxOffset)
  const end = lines.length - clampedOffset
  const start = Math.max(0, end - maxLines)
  return lines.slice(start, end)
}

function emptyTranscript(height: number): string[] {
  return Array.from({ length: height }, () => "")
}

function noticeLinesForScreen(notice: string | undefined, width: number, height: number): string[] {
  if (!notice) return []
  const rawNotice = ["", ...renderNotice(notice, width).split("\n")]
  const maxNoticeLines = Math.max(0, height - 14)
  return maxNoticeLines > 0 ? fitBlock(rawNotice, width, maxNoticeLines) : []
}

function padLines(lines: string[], height: number): string[] {
  const clipped = lines.slice(0, height)
  while (clipped.length < height) clipped.push("")
  return clipped
}

function fitBlock(lines: string[], width: number, maxLines: number): string[] {
  const fitted = lines.flatMap((line) => wrapAnsiLine(line, width))
  if (fitted.length <= maxLines) return fitted
  return [
    ...fitted.slice(0, Math.max(0, maxLines - 1)),
    `${ansi.dim}${truncatePlain(`... ${fitted.length - maxLines + 1} more lines`, width)}${ansi.reset}`,
  ]
}

function padAnsi(text: string, width: number): string {
  const visible = visibleLength(text)
  if (visible >= width) return truncateAnsi(text, width)
  return `${text}${" ".repeat(width - visible)}`
}

function padVisible(text: string, width: number): string {
  const visible = visibleLength(text)
  if (visible >= width) return truncateAnsi(text, width)
  return `${text}${" ".repeat(width - visible)}`
}

function shouldShowSidebar(width: number): boolean {
  return width >= 88
}

function sessionStats(messages: Message[]): {
  messages: number
  toolCalls: number
  toolResults: number
  failedTools: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimated: boolean
} {
  let inputChars = 0
  let outputChars = 0
  let toolCalls = 0
  let toolResults = 0
  let failedTools = 0
  let realInputTokens = 0
  let realOutputTokens = 0
  let realTotalTokens = 0

  for (const message of messages) {
    if (message.usage) {
      realInputTokens += message.usage.inputTokens
      realOutputTokens += message.usage.outputTokens
      realTotalTokens += message.usage.totalTokens
    }

    for (const part of message.parts) {
      if (part.type === "text") {
        if (message.role === "user" || message.role === "system") inputChars += part.text.length
        else outputChars += part.text.length
      }
      if (part.type === "tool_call") {
        toolCalls += 1
        inputChars += summarizeValue(part.input).length
      }
      if (part.type === "tool_result") {
        toolResults += 1
        if (part.error) failedTools += 1
        outputChars += summarizeValue(part.output).length + (part.error?.length ?? 0)
      }
    }
  }

  if (realInputTokens > 0 || realOutputTokens > 0 || realTotalTokens > 0) {
    return {
      messages: messages.length,
      toolCalls,
      toolResults,
      failedTools,
      inputTokens: realInputTokens,
      outputTokens: realOutputTokens,
      totalTokens: realTotalTokens || realInputTokens + realOutputTokens,
      estimated: false,
    }
  }

  const inputTokens = estimateTokens(inputChars)
  const outputTokens = estimateTokens(outputChars)
  return {
    messages: messages.length,
    toolCalls,
    toolResults,
    failedTools,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  }
}

function estimateTokens(chars: number): number {
  if (chars <= 0) return 0
  return Math.max(1, Math.ceil(chars / 4))
}

function wrapPlain(text: string, width: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n")
  return normalized.split("\n").flatMap((line) => wrapAnsiLine(line, width))
}

function wrapAnsiLine(line: string, width: number): string[] {
  if (visibleLength(line) <= width) return [line]
  const plain = stripAnsi(line)
  const wrapped: string[] = []
  let remaining = plain

  while (remaining.length > width) {
    let breakpoint = remaining.lastIndexOf(" ", width)
    if (breakpoint <= 0) breakpoint = width
    wrapped.push(remaining.slice(0, breakpoint))
    remaining = remaining.slice(breakpoint).trimStart()
  }

  if (remaining.length > 0) wrapped.push(remaining)
  return wrapped
}

function truncateAnsi(text: string, width: number): string {
  if (visibleLength(text) <= width) return text
  return `${stripAnsi(text).slice(0, Math.max(0, width - 3))}...`
}

function truncatePlain(text: string, width: number): string {
  if (text.length <= width) return text
  return `${text.slice(0, Math.max(0, width - 3))}...`
}

function trimMiddle(text: string, width: number): string {
  if (text.length <= width) return text
  if (width <= 5) return truncatePlain(text, width)
  const left = Math.ceil((width - 3) / 2)
  const right = Math.floor((width - 3) / 2)
  return `${text.slice(0, left)}...${text.slice(text.length - right)}`
}

function visibleLength(text: string): number {
  return stripAnsi(text).length
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  return JSON.stringify(value)
}

function summarizeText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim()
  if (!compact) return ""
  return ansi.dim + truncatePlain(compact, 140) + ansi.reset
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace("#", "")
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return { r: 255, g: 255, b: 255 }
  }

  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  }
}
