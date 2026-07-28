import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import {
  createSystemClipboardAdapter,
  type ClipboardSpawn,
} from "../src/adapters/tui/clipboard.js"

describe("TUI clipboard adapter", () => {
  it("reports a useful error when Linux clipboard commands are unavailable", async () => {
    const spawn: ClipboardSpawn = () => {
      const child = new EventEmitter() as ReturnType<ClipboardSpawn> & EventEmitter
      child.stdin = { write: () => undefined, end: () => undefined }
      queueMicrotask(() => child.emit("error", new Error("missing")))
      return child
    }
    const clipboard = createSystemClipboardAdapter("linux", spawn)
    await expect(clipboard.writeText("hello")).rejects.toThrow(
      "clipboard unavailable (install xclip or xsel)",
    )
  })
})
