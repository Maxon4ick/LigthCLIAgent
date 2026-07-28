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
  | { type: "skills" }
  | { type: "skills_import"; bundlePath?: string }
  | { type: "bundle_install"; bundlePath?: string }
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
  hint("/help", "Show command palette"),
  hint("/new", "Create and switch session"),
  hint("/clear", "Redraw the TUI"),
  hint("/clear-history", "Delete current transcript"),
  hint("/forget", "Delete current session"),
  hint("/sessions", "List sessions", undefined, ["/resume", "/continue"]),
  hint("/use <id>", "Switch session", "/use "),
  hint("/history", "Show current transcript", undefined, ["/messages"]),
  hint("/status", "Show runtime status"),
  hint("/config", "Show effective config"),
  hint("/tools", "List registered tools"),
  hint("/models", "Show model catalog"),
  hint("/model", "Show active model"),
  hint("/connect", "Set provider, API key & model (persisted)"),
  hint("/switch <model>", "Switch model", "/switch "),
  hint("/diff", "Show edit snapshots"),
  hint("/revert", "Revert current session edits"),
  hint("/abort", "Cancel active run"),
  hint("/mode build", "Build mode: normal permission policy"),
  hint("/mode plan", "Plan mode: read/search + safe planning state"),
  hint("/mode explore", "Explore mode: read/search only"),
  hint("/mode orchestrate", "Orchestrate: read/search + delegation only"),
  hint("/compact", "Summarize and trim old transcript"),
  hint("/fork", "Fork current session"),
  hint("/keys", "List stored API keys"),
  hint("/key-add", "Store or update an API key"),
  hint("/key-delete", "Delete a stored API key"),
  hint("/model-remove", "Remove a custom model from the catalog"),
  hint("/copy", "Enter copy/yank mode"),
  hint("/skills", "List workspace skills"),
  hint("/skills-import [<path>]", "Import a skill bundle", "/skills-import "),
  hint("/skills-bundle-install [<path>]", "Install bundle resources", "/skills-bundle-install "),
  hint("/exit", "Quit", undefined, ["/quit", "/q"]),
]

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
  if (["sessions", "resume", "continue"].includes(command)) return { type: "sessions" }
  if (command === "history" || command === "messages") return { type: "history" }
  if (["config", "status", "tools"].includes(command)) return { type: command as "config" | "status" | "tools" }
  if (command === "models" || command === "model") return { type: "models" }
  if (command === "connect") return { type: "connect" }
  if (command === "switch") return { type: "switch", ref: rest[0] ?? "" }
  if (["diff", "revert", "abort", "compact", "fork", "keys"].includes(command)) {
    return { type: command as "diff" | "revert" | "abort" | "compact" | "fork" | "keys" }
  }
  if (command === "key-add" || command === "key-set") return { type: "key_add" }
  if (command === "key-delete" || command === "key-remove") return { type: "key_delete" }
  if (command === "model-remove" || command === "model-delete") return { type: "model_remove" }
  if (command === "mode" && isMode(rest[0])) return { type: "mode", mode: rest[0] }
  if (command === "use" && rest[0]) return { type: "use", sessionId: rest[0] }
  if (command === "copy" || command === "yank") return { type: "copy" }
  if (command === "skills") return { type: "skills" }
  if (command === "skills-import" || command === "import-skills") {
    return { type: "skills_import", bundlePath: rest[0] }
  }
  if (command === "skills-bundle-install" || command === "bundle-install") {
    return { type: "bundle_install", bundlePath: rest[0] }
  }
  return { type: "unknown", input: trimmed }
}

export function suggestSlashCommands(
  input: string,
  hints: SlashCommandHint[] = slashCommandHints,
): SlashCommandHint[] {
  const query = input.trimStart().toLowerCase()
  if (!query.startsWith("/")) return []
  return hints
    .filter((entry) =>
      [entry.command, entry.insert, ...(entry.aliases ?? [])]
        .some((value) => value.toLowerCase().replace(/[ <].*$/, "").startsWith(query)),
    )
    .slice(0, 7)
}

function hint(
  command: string,
  description: string,
  insert = command,
  aliases?: string[],
): SlashCommandHint {
  return { command, description, insert, aliases }
}

function isMode(value: string | undefined): value is "build" | "plan" | "explore" | "orchestrate" {
  return value === "build" || value === "plan" || value === "explore" || value === "orchestrate"
}
