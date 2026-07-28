import { loadConfig } from "../../core/config/config-loader.js"
import { openRuntimeState } from "../../core/storage/open-runtime-state.js"

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
  const opened = await openState()
  try {
    const entries = opened.state.secrets.list()
    if (entries.length === 0) {
      process.stdout.write("No API keys stored.\n")
      return
    }
    process.stdout.write("Stored API keys:\n")
    for (const entry of entries) {
      process.stdout.write(`  ${entry.provider}  (updated ${entry.updatedAt})\n`)
    }
  } finally {
    await opened.dispose()
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

  const opened = await openState()
  try {
    opened.state.secrets.set(provider, apiKey)
    process.stdout.write(`API key for "${provider}" saved.\n`)
  } finally {
    await opened.dispose()
  }
}

async function keysDelete(args: string[]): Promise<void> {
  const [provider] = args
  if (!provider) {
    throw new Error("keys delete requires a provider name. Example: agent-cli keys delete anthropic")
  }

  const opened = await openState()
  try {
    opened.state.secrets.delete(provider)
    process.stdout.write(`API key for "${provider}" deleted.\n`)
  } finally {
    await opened.dispose()
  }
}

async function openState() {
  const config = await loadConfig({ cwd: process.cwd() })
  return openRuntimeState(config, process.cwd())
}

function printKeysHelp(): void {
  process.stdout.write(`Manage stored API keys (persisted in a local file by default).

Usage:
  agent-cli keys list
  agent-cli keys set <provider> <api-key>
  agent-cli keys delete <provider>

Providers: anthropic, openai-compatible, gemini, or any custom provider name.

Stored keys are automatically used at runtime when no key is found in the
environment or config file. The local file is permission-restricted but is
not an encrypted vault; environment variables are recommended for provider keys.
`)
}
