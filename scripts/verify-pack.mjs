import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("npm_execpath is required for npm package verification")

const output = execFileSync(
  process.execPath,
  [npmCli, "pack", "--dry-run", "--json"],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
)
const reports = JSON.parse(output)
if (!Array.isArray(reports) || reports.length !== 1 || !Array.isArray(reports[0]?.files)) {
  throw new Error("npm pack returned an unexpected JSON report")
}

const files = reports[0].files.map((entry) => String(entry.path).replaceAll("\\", "/"))
const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/cli/index.js",
  "dist/adapters/http/index.js",
  "dist/adapters/tui/index.js",
  "dist/adapters/sqlite/index.js",
]
for (const expected of required) {
  if (!files.includes(expected)) throw new Error(`npm package is missing ${expected}`)
}
if (!files.some((name) => name.startsWith("dist/") && name.endsWith(".d.ts"))) {
  throw new Error("npm package does not contain TypeScript declarations")
}

const forbidden = [
  /^src\//,
  /^test\//,
  /^dist\/test(?:\/|$)/,
  /^\.agents(?:\/|$)/,
  /^\.agent-cli(?:\/|$)/,
  /^\.claude(?:\/|$)/,
  /^opencode(?:\/|$)/,
  /^qwen-code(?:\/|$)/,
  /^ascend310p-operator-porting(?:\/|$)/,
  /^agent-cli\.config\.json$/,
  /(?:^|\/)\.env(?:\.|$)/,
  /\.(?:db|sqlite|sqlite3)(?:-|$)/,
  /\.tgz$/,
  /^coverage(?:\/|$)/,
  /^reports?(?:\/|$)/,
  /(?:^|\/)[^/]*(?:prompt|report)[^/]*$/i,
]
const leaked = files.filter((name) => forbidden.some((pattern) => pattern.test(name)))
if (leaked.length > 0) {
  throw new Error(`npm package contains forbidden local files:\n${leaked.join("\n")}`)
}

const allowedTopLevel = new Set(["LICENSE", "README.md", "package.json", "dist"])
const unexpectedTopLevel = files.filter((name) => !allowedTopLevel.has(name.split("/")[0]))
if (unexpectedTopLevel.length > 0) {
  throw new Error(`npm package contains unexpected top-level entries:\n${unexpectedTopLevel.join("\n")}`)
}

const limits = {
  entryCount: 500,
  packedBytes: 500_000,
  unpackedBytes: 1_500_000,
}
if (reports[0].entryCount > limits.entryCount) {
  throw new Error(`npm package has ${reports[0].entryCount} entries (budget: ${limits.entryCount})`)
}
if (reports[0].size > limits.packedBytes) {
  throw new Error(`npm package is ${reports[0].size} compressed bytes (budget: ${limits.packedBytes})`)
}
if (reports[0].unpackedSize > limits.unpackedBytes) {
  throw new Error(`npm package is ${reports[0].unpackedSize} unpacked bytes (budget: ${limits.unpackedBytes})`)
}

const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
if (manifest.license !== "UNLICENSED") {
  throw new Error(`Expected package license UNLICENSED, got ${String(manifest.license)}`)
}
if (!readFileSync(path.join(root, "LICENSE"), "utf8").startsWith("UNLICENSED")) {
  throw new Error("LICENSE must not claim an open-source license while package.json is UNLICENSED")
}

process.stdout.write(`Verified npm package boundary (${files.length} files).\n`)
