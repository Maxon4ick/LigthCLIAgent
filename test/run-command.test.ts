import { describe, expect, it } from "vitest"
import { runCommand } from "../src/cli/commands/run.js"

describe("run command", () => {
  it("rejects unknown flags instead of treating them as prompt text", async () => {
    await expect(runCommand(["--storag", "memory", "hello"])).rejects.toThrow("Unknown run argument: --storag")
  })
})
