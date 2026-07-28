import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("npm_execpath is required for tarball smoke")

const scratch = mkdtempSync(path.join(os.tmpdir(), "agent-cli-tarball-smoke-"))
try {
  const packOutput = execFileSync(
    process.execPath,
    [npmCli, "pack", "--json", "--pack-destination", scratch],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
  const reports = JSON.parse(packOutput)
  if (!Array.isArray(reports) || reports.length !== 1 || !reports[0]?.filename) {
    throw new Error("npm pack returned an unexpected report")
  }

  const consumer = path.join(scratch, "consumer")
  const tarball = path.join(scratch, reports[0].filename)
  writeFileSync(path.join(scratch, "package.json"), '{"private":true,"type":"module"}\n', "utf8")
  execFileSync(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumer,
      tarball,
    ],
    { cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )

  const packageRoot = path.join(consumer, "node_modules", "agent-cli-scaffold")
  const cli = path.join(packageRoot, "dist", "cli", "index.js")
  assertRun(cli, ["--help"], consumer, "Usage:")
  assertRun(cli, ["run", "--storage", "memory", "hello"], consumer, 'Mock response: received "hello".')
  assertRun(cli, ["run", "--storage", "file", "hello"], consumer, 'Mock response: received "hello".')
  assertFailure(
    cli,
    ["run", "--storage", "sqlite", "hello"],
    consumer,
    'SQLite storage is optional and requires "better-sqlite3".',
  )

  const librarySmoke = `
    import { createRuntime, defaultConfig, mergeConfig, createSession, addUserPrompt } from ${JSON.stringify(
      pathToFileURL(path.join(packageRoot, "dist", "index.js")).href,
    )}
    const config = mergeConfig(defaultConfig, { storage: { kind: "memory" } })
    const runtime = await createRuntime({ config, cwd: process.cwd() })
    const session = createSession(runtime)
    addUserPrompt(runtime, session.id, "hello")
    const result = await runtime.startSession(session.id).promise
    if (!result.assistantText.includes('Mock response: received "hello".')) throw new Error("unexpected mock response")
    await runtime.dispose()
  `
  execFileSync(process.execPath, ["--input-type=module", "--eval", librarySmoke], {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })

  const forbiddenSqlite = path.join(consumer, "node_modules", "better-sqlite3")
  if (existsSync(forbiddenSqlite)) {
    throw new Error("Minimal tarball install unexpectedly included better-sqlite3")
  }

  process.stdout.write(`Installed and verified ${reports[0].filename} with --omit=optional.\n`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

function assertRun(cli, args, cwd, expected) {
  const output = execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (!output.includes(expected)) {
    throw new Error(`Installed CLI output did not include ${JSON.stringify(expected)}`)
  }
}

function assertFailure(cli, args, cwd, expected) {
  try {
    execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`
    if (!output.includes(expected)) {
      throw new Error(`Installed CLI error did not include ${JSON.stringify(expected)}`)
    }
    if (output.includes("\n    at ")) throw new Error("Installed CLI printed a stack trace")
    return
  }
  throw new Error("Installed CLI unexpectedly accepted SQLite without better-sqlite3")
}
