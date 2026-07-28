import { spawn } from "node:child_process"

export interface ClipboardAdapter {
  writeText(text: string): Promise<void>
}

interface ClipboardProcess {
  stdin: {
    write(text: string, encoding: BufferEncoding): void
    end(): void
  }
  on(event: "close", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
}

export type ClipboardSpawn = (command: string, args: string[]) => ClipboardProcess

export function createSystemClipboardAdapter(
  platform = process.platform,
  spawnProcess: ClipboardSpawn = (command, args) =>
    spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] }) as unknown as ClipboardProcess,
): ClipboardAdapter {
  return {
    writeText: (text) => copyText(text, platform, spawnProcess),
  }
}

export const systemClipboard = createSystemClipboardAdapter()

function copyText(text: string, platform: NodeJS.Platform, spawnProcess: ClipboardSpawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = platform === "win32" ? "clip.exe" : platform === "darwin" ? "pbcopy" : "xclip"
    const args = platform === "linux" ? ["-selection", "clipboard"] : []
    const child = spawnProcess(command, args)
    child.stdin.write(text, "utf8")
    child.stdin.end()
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`clipboard exited with code ${String(code)}`))
    })
    child.on("error", (error) => {
      if (platform !== "linux") {
        reject(error)
        return
      }
      const fallback = spawnProcess("xsel", ["--clipboard", "--input"])
      fallback.stdin.write(text, "utf8")
      fallback.stdin.end()
      fallback.on("close", (code) => {
        if (code === 0) resolve()
        else reject(new Error("clipboard unavailable (install xclip or xsel)"))
      })
      fallback.on("error", () => reject(new Error("clipboard unavailable (install xclip or xsel)")))
    })
  })
}
