import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(root, "dist", "cli", "index.js")
run(["--help"])
run(["config"])
const memory = run(["run", "--storage", "memory", "hello"])
if (!memory.includes('Mock response: received "hello".')) throw new Error("Memory smoke did not return the mock response")

const temp = mkdtempSync(path.join(os.tmpdir(), "agent-cli-local-smoke-"))
try {
  const file = run(["run", "--storage", "file", "hello"], temp)
  if (!file.includes('Mock response: received "hello".')) throw new Error("File smoke did not return the mock response")
} finally {
  rmSync(temp, { recursive: true, force: true })
}

function run(args, cwd = root) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}
