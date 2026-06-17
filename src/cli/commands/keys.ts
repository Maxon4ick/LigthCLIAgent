import { loadConfig } from "../../core/config/config-loader.js"
import { SqliteDatabase, resolveDbPath } from "../../core/storage/sqlite-db.js"

export async function keysCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printKeysHelp()
    return
  }

  if (subcommand === "list") {
    await keysList()
    return
  }

  if (subcommand === "set") {
    await keysSet(rest)
    return
  }

  if (subcommand === "delete") {
    await keysDelete(rest)
    return
  }

  process.stderr.write(`Unknown keys subcommand: ${subcommand}\n\n`)
  printKeysHelp()
  process.exitCode = 1
}

async function keysList(): Promise<void> {
  const db = await openDb()
  try {
    const entries = db.listApiKeys()
    if (entries.length === 0) {
      process.stdout.write("No API keys stored.\n")
      return
    }
    process.stdout.write("Stored API keys:\n")
    for (const entry of entries) {
      process.stdout.write(`  ${entry.provider}  (updated ${entry.updatedAt})\n`)
    }
  } finally {
    db.close()
  }
}

async function keysSet(args: string[]): Promise<void> {
  const [provider, apiKey] = args
  if (!provider) {
    throw new Error("keys set requires a provider name. Example: agent-cli keys set anthropic sk-...")
  }
  if (!apiKey) {
    throw new Error("keys set requires an API key value. Example: agent-cli keys set anthropic sk-...")
  }

  const db = await openDb()
  try {
    db.setApiKey(provider, apiKey)
    process.stdout.write(`API key for "${provider}" saved.\n`)
  } finally {
    db.close()
  }
}

async function keysDelete(args: string[]): Promise<void> {
  const [provider] = args
  if (!provider) {
    throw new Error("keys delete requires a provider name. Example: agent-cli keys delete anthropic")
  }

  const db = await openDb()
  try {
    db.deleteApiKey(provider)
    process.stdout.write(`API key for "${provider}" deleted.\n`)
  } finally {
    db.close()
  }
}

async function openDb(): Promise<SqliteDatabase> {
  const config = await loadConfig({ cwd: process.cwd() })
  const dbPath = resolveDbPath(process.cwd(), config.storage.dbPath)
  return new SqliteDatabase(dbPath)
}

function printKeysHelp(): void {
  process.stdout.write(`Manage stored API keys (persisted in SQLite).

Usage:
  agent-cli keys list
  agent-cli keys set <provider> <api-key>
  agent-cli keys delete <provider>

Providers: anthropic, openai-compatible, gemini, or any custom provider name.

Stored keys are automatically used at runtime when no key is found in the
environment or config file.
`)
}
