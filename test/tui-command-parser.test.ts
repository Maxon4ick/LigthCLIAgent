import { describe, expect, it } from "vitest"
import {
  parseTuiCommand,
  suggestSlashCommands,
} from "../src/adapters/tui/commands/parser.js"

describe("pure TUI command parser", () => {
  it("parses prompts, aliases, modes, and arguments without side effects", () => {
    expect(parseTuiCommand("hello")).toEqual({ type: "prompt", prompt: "hello" })
    expect(parseTuiCommand("/q")).toEqual({ type: "exit" })
    expect(parseTuiCommand("/mode explore")).toEqual({ type: "mode", mode: "explore" })
    expect(parseTuiCommand("/use session-1")).toEqual({ type: "use", sessionId: "session-1" })
  })

  it("suggests matching slash commands", () => {
    expect(suggestSlashCommands("/key").map((hint) => hint.command)).toEqual([
      "/keys",
      "/key-add",
      "/key-delete",
    ])
  })
})
