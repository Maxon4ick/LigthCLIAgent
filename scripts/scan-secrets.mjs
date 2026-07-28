import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MAX_FILE_BYTES = 1_000_000
const EXCLUDED_PREFIXES = [
  ".git/",
  "node_modules/",
  "opencode/",
  "qwen-code/",
  "ascend310p-operator-porting/",
  ".agent-cli/",
  ".claude/",
  "coverage/",
]
const REVIEWED_ALLOWLIST = [
  { path: "scripts/scan-secrets.mjs", rule: "sensitive-field" },
]

const rules = [
  ["private-key-header", new RegExp(["-{5}BEGIN ", "(?:RSA |EC |OPENSSH )?", "PRIVATE KEY-{5}"].join(""))],
  ["openai-key", new RegExp(["\\bsk-", "(?:proj-)?", "[A-Za-z0-9_-]{32,}\\b"].join(""))],
  ["github-token", new RegExp(["\\bgh", "[pousr]_", "[A-Za-z0-9]{30,}\\b"].join(""))],
  ["aws-access-key", new RegExp(["\\bAK", "IA[0-9A-Z]{16}\\b"].join(""))],
  ["slack-token", new RegExp(["\\bxox", "[baprs]-", "[A-Za-z0-9-]{20,}\\b"].join(""))],
  ["bearer-token", new RegExp(["\\bBearer\\s+", "[A-Za-z0-9_-]{32,}\\b"].join(""), "i")],
  ["jwt", new RegExp(["\\beyJ[A-Za-z0-9_-]{10,}\\.", "[A-Za-z0-9_-]{10,}\\.", "[A-Za-z0-9_-]{10,}\\b"].join(""))],
]

export function scanText(text, filePath = "input.txt", production = false) {
  const findings = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const [id, pattern] of rules) {
      if (id === "jwt" && !production) continue
      if (pattern.test(line) && !isPlaceholder(line) && !isAllowed(filePath, id)) {
        findings.push({ path: filePath, line: index + 1, rule: id })
      }
    }

    const sensitive = line.match(
      /(?:api[_-]?key|password|secret)\s*["']?\s*[:=]\s*["']([^"']{8,})["']/i,
    )
    if (
      sensitive &&
      !isPlaceholder(sensitive[1]) &&
      !isAllowed(filePath, "sensitive-field")
    ) {
      findings.push({ path: filePath, line: index + 1, rule: "sensitive-field" })
    }
  }
  return findings
}

export function scanPaths(paths, repositoryRoot = root) {
  const findings = []
  for (const relativePath of [...new Set(paths.map(normalizePath))].sort()) {
    if (shouldExclude(relativePath)) continue
    if (/^\.env(?:\.|$)/i.test(path.basename(relativePath))) {
      findings.push({ path: relativePath, line: 1, rule: "env-file" })
      continue
    }
    if (/\.(?:pem|key)$/i.test(relativePath)) {
      findings.push({ path: relativePath, line: 1, rule: "private-key-file" })
      continue
    }

    const absolutePath = path.resolve(repositoryRoot, relativePath)
    let stat
    try {
      stat = statSync(absolutePath)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
    const buffer = readFileSync(absolutePath)
    if (buffer.includes(0)) continue
    findings.push(...scanText(buffer.toString("utf8"), relativePath, relativePath.startsWith("dist/")))
  }
  return findings
}

export function collectScanPaths(repositoryRoot = root) {
  const gitPaths = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).split("\0").filter(Boolean)

  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error("npm_execpath is required for package secret scanning")
  const packOutput = execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const reports = JSON.parse(packOutput)
  if (!Array.isArray(reports) || !Array.isArray(reports[0]?.files)) {
    throw new Error("npm pack returned an unexpected JSON report")
  }
  const packagePaths = reports[0].files.map((entry) => String(entry.path))
  return [...gitPaths, ...packagePaths]
}

function isPlaceholder(value) {
  return /(?:placeholder|example|dummy|fake|mock|redacted|test[-_ ]|your[-_ <]|changeme|not[-_ ]?a[-_ ]?real|x{4,}|\*{4,}|<[^>]+>)/i
    .test(value)
}

function isAllowed(filePath, rule) {
  return REVIEWED_ALLOWLIST.some((entry) => entry.path === normalizePath(filePath) && entry.rule === rule)
}

function shouldExclude(filePath) {
  return EXCLUDED_PREFIXES.some((prefix) => filePath.startsWith(prefix))
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "")
}

function main() {
  const findings = scanPaths(collectScanPaths())
  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(`${finding.path}:${finding.line} ${finding.rule}\n`)
    }
    process.exitCode = 1
    return
  }
  process.stdout.write("Secret scan passed for tracked files and npm package contents.\n")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
