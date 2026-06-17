import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(root, "dist", "src", "cli", "index.js")

run(["config"])
run(["run", "--storage", "memory", "hello"])

function run(args) {
  execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}
