#!/usr/bin/env node
import { configCommand } from "./commands/config.js"
import { keysCommand } from "./commands/keys.js"
import { modelsCommand } from "./commands/models.js"
import { runCommand } from "./commands/run.js"
import { serveCommand } from "./commands/serve.js"
import { tuiCommand } from "./commands/tui.js"

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)

  if (!command || command === "--help" || command === "-h") {
    printHelp()
    return
  }

  if (command === "run") {
    await runCommand(args)
    return
  }

  if (command === "serve") {
    await serveCommand(args)
    return
  }

  if (command === "tui") {
    await tuiCommand(args)
    return
  }

  if (command === "config") {
    await configCommand(args)
    return
  }

  if (command === "keys") {
    await keysCommand(args)
    return
  }

  if (command === "models") {
    await modelsCommand(args)
    return
  }

  process.stderr.write(`Unknown command: ${command}\n\n`)
  printHelp()
  process.exitCode = 1
}

function printHelp(): void {
  process.stdout.write(`agent-cli

Usage:
  agent-cli run [--json] [--provider mock|openai-compatible|anthropic|gemini|<custom>] [--model <id>] [--base-url <url>] [--api-key <key>] [--allow-shell] [--allow-edit] [--allow-network] [--ask-permissions] [--approval-timeout-ms <ms>] [--session <id>] [--storage memory|file|sqlite] "prompt"
  agent-cli tui [--provider mock|openai-compatible|anthropic|gemini|<custom>] [--model <id>] [--base-url <url>] [--storage memory|file|sqlite]
  agent-cli serve [--host 127.0.0.1] [--port 4170] [--provider mock|openai-compatible|anthropic|gemini|<custom>] [--model <id>] [--base-url <url>] [--auth-token <token>] [--allow-edit] [--allow-network] [--ask-permissions] [--approval-timeout-ms <ms>] [--storage memory|file|sqlite]
  agent-cli config
  agent-cli keys list|set|delete          Manage stored API keys
  agent-cli models list|add|remove        Manage custom model catalog
`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
