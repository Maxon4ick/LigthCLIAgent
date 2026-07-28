#!/usr/bin/env node

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)

  if (!command || command === "--help" || command === "-h") {
    printHelp()
    return
  }

  if (command === "run") {
    const { runCommand } = await import("./commands/run.js")
    await runCommand(args)
    return
  }

  if (command === "serve") {
    const { serveCommand } = await import("./commands/serve.js")
    await serveCommand(args)
    return
  }

  if (command === "tui") {
    const { tuiCommand } = await import("./commands/tui.js")
    await tuiCommand(args)
    return
  }

  if (command === "config") {
    const { configCommand } = await import("./commands/config.js")
    await configCommand(args)
    return
  }

  if (command === "keys") {
    const { keysCommand } = await import("./commands/keys.js")
    await keysCommand(args)
    return
  }

  if (command === "models") {
    const { modelsCommand } = await import("./commands/models.js")
    await modelsCommand(args)
    return
  }

  if (command === "skills") {
    const { skillsCommand } = await import("./commands/skills.js")
    await skillsCommand(args)
    return
  }

  if (command === "tools") {
    const { toolsCommand } = await import("./commands/tools.js")
    await toolsCommand(args)
    return
  }

  process.stderr.write(`Unknown command: ${command}\n\n`)
  printHelp()
  process.exitCode = 1
}

function printHelp(): void {
  process.stdout.write(`agent-cli

Usage:
  agent-cli run [--json] [--mode build|plan|explore|orchestrate] [--provider mock|openai-compatible|anthropic|gemini|<custom>] [--model <id>] [--base-url <url>] [--api-key <key>] [--allow-shell] [--allow-edit] [--allow-network] [--ask-permissions] [--approval-timeout-ms <ms>] [--session <id>] [--storage memory|file|sqlite] "prompt"
  agent-cli tui [--provider mock|openai-compatible|anthropic|gemini|<custom>] [--model <id>] [--base-url <url>] [--storage memory|file|sqlite]
  agent-cli serve [--host 127.0.0.1] [--port 4170] [--provider mock|openai-compatible|anthropic|gemini|<custom>] [--model <id>] [--base-url <url>] [--auth-token <token>] [--allow-edit] [--allow-network] [--ask-permissions] [--approval-timeout-ms <ms>] [--storage memory|file|sqlite]
  agent-cli config
  agent-cli keys list|set|delete          Manage stored API keys
  agent-cli models list|add|remove        Manage custom model catalog
  agent-cli skills list|add|import|remove|bundle  Manage agent skills
  agent-cli tools inspect <manifest>              Validate metadata without executing code
  agent-cli tools list [--allow-local-extension <manifest>]

Modes are enforced before tool execution: plan/explore are read-only;
orchestrate can delegate but cannot directly edit, run shell, or use network.
Bundle hooks and executable tools are copied only as inactive P0 resources.
Local ESM tools execute only when explicitly trusted with --allow-local-extension.
`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
