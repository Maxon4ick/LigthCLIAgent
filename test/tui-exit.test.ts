import { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"

describe("TUI exit", () => {
  it("exits after /exit input", async () => {
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/cli/index.ts", "tui", "--storage", "memory"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    })

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      let stderr = ""
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error("TUI did not exit after /exit"))
      }, 5000)

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8")
      })
      child.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once("exit", (code) => {
        clearTimeout(timeout)
        resolve({ code, stderr })
      })
      child.stdin.end("/exit\n")
    })

    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
  })
})
