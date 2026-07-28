import { existsSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const target = path.resolve(root, "dist")

if (path.dirname(target) !== path.resolve(root) || path.basename(target) !== "dist" || !existsSync(path.join(root, "package.json"))) {
  throw new Error(`Refusing to clean unexpected build target: ${target}`)
}

rmSync(target, { recursive: true, force: true })
