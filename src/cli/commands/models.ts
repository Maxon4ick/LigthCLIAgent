import { loadConfig } from "../../core/config/config-loader.js"
import type { ModelCapabilities, ProviderProtocol } from "../../core/config/schema.js"
import { listModelCatalog } from "../../core/llm/model-registry.js"
import { SqliteDatabase, resolveDbPath } from "../../core/storage/sqlite-db.js"

export async function modelsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printModelsHelp()
    return
  }

  if (subcommand === "list") {
    await modelsList()
    return
  }

  if (subcommand === "add") {
    await modelsAdd(rest)
    return
  }

  if (subcommand === "remove") {
    await modelsRemove(rest)
    return
  }

  process.stderr.write(`Unknown models subcommand: ${subcommand}\n\n`)
  printModelsHelp()
  process.exitCode = 1
}

async function modelsList(): Promise<void> {
  const config = await loadConfig({ cwd: process.cwd() })
  const db = openDb(config.storage.dbPath)
  try {
    const effective = db.applyOverrides(config)
    const catalog = listModelCatalog(effective)
    if (catalog.length === 0) {
      process.stdout.write("No models in catalog.\n")
      return
    }
    process.stdout.write("Model catalog:\n")
    for (const entry of catalog) {
      const name = entry.displayName ? `${entry.displayName} (${entry.model})` : entry.model
      const caps = formatCaps(entry.capabilities)
      process.stdout.write(`  ${entry.provider}/${name}  [${entry.protocol}]  ${caps}\n`)
    }
  } finally {
    db.close()
  }
}

async function modelsAdd(args: string[]): Promise<void> {
  let provider: string | undefined
  let model: string | undefined
  let displayName: string | undefined
  let protocol: ProviderProtocol | undefined
  let tools = true
  let streaming = true
  let usage = true
  let reasoning = false
  let imageInput = false
  let maxContextTokens: number | undefined
  let maxOutputTokens: number | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === "--provider") {
      provider = args[++i]
      continue
    }
    if (arg === "--model") {
      model = args[++i]
      continue
    }
    if (arg === "--display-name") {
      displayName = args[++i]
      continue
    }
    if (arg === "--protocol") {
      protocol = args[++i] as ProviderProtocol
      continue
    }
    if (arg === "--no-tools") { tools = false; continue }
    if (arg === "--no-streaming") { streaming = false; continue }
    if (arg === "--no-usage") { usage = false; continue }
    if (arg === "--reasoning") { reasoning = true; continue }
    if (arg === "--image-input") { imageInput = true; continue }
    if (arg === "--max-context-tokens") {
      maxContextTokens = parseInt(args[++i], 10)
      continue
    }
    if (arg === "--max-output-tokens") {
      maxOutputTokens = parseInt(args[++i], 10)
      continue
    }

    throw new Error(`Unknown models add argument: ${arg}`)
  }

  if (!provider) throw new Error("models add requires --provider")
  if (!model) throw new Error("models add requires --model")
  if (!protocol) throw new Error("models add requires --protocol")

  const validProtocols: ProviderProtocol[] = [
    "mock",
    "openai-chat",
    "openai-compatible",
    "anthropic-messages",
    "gemini-generative-language",
  ]
  if (!validProtocols.includes(protocol)) {
    throw new Error(`--protocol must be one of: ${validProtocols.join(", ")}`)
  }

  const capabilities: ModelCapabilities = {
    tools,
    streaming,
    usage,
    reasoning,
    imageInput,
    maxContextTokens,
    maxOutputTokens,
  }

  const config = await loadConfig({ cwd: process.cwd() })
  const db = openDb(config.storage.dbPath)
  try {
    db.upsertCustomModel({ provider, model, displayName, protocol, capabilities })
    process.stdout.write(`Model "${provider}/${model}" saved.\n`)
  } finally {
    db.close()
  }
}

async function modelsRemove(args: string[]): Promise<void> {
  const [provider, model] = args
  if (!provider || !model) {
    throw new Error("models remove requires <provider> <model>. Example: agent-cli models remove anthropic claude-3-haiku-20240307")
  }

  const config = await loadConfig({ cwd: process.cwd() })
  const db = openDb(config.storage.dbPath)
  try {
    db.deleteCustomModel(provider, model)
    process.stdout.write(`Model "${provider}/${model}" removed.\n`)
  } finally {
    db.close()
  }
}

function openDb(dbPath: string): SqliteDatabase {
  return new SqliteDatabase(resolveDbPath(process.cwd(), dbPath))
}

function formatCaps(caps: ModelCapabilities): string {
  const flags: string[] = []
  if (caps.tools) flags.push("tools")
  if (caps.streaming) flags.push("streaming")
  if (caps.reasoning) flags.push("reasoning")
  if (caps.imageInput) flags.push("images")
  if (caps.maxContextTokens) flags.push(`${(caps.maxContextTokens / 1000).toFixed(0)}k ctx`)
  return flags.length > 0 ? flags.join(", ") : "basic"
}

function printModelsHelp(): void {
  process.stdout.write(`Manage the model catalog (custom models persisted in SQLite).

Usage:
  agent-cli models list
  agent-cli models add --provider <p> --model <id> --protocol <proto> [options]
  agent-cli models remove <provider> <model>

Protocols: mock, openai-chat, openai-compatible, anthropic-messages, gemini-generative-language

Options for "add":
  --display-name <name>       Human-readable label
  --no-tools                  Model does not support tool use
  --no-streaming              Model does not support streaming
  --no-usage                  Model does not report token usage
  --reasoning                 Model supports extended reasoning
  --image-input               Model accepts image inputs
  --max-context-tokens <n>    Maximum context window size
  --max-output-tokens <n>     Maximum output tokens

Examples:
  agent-cli models add --provider anthropic --model claude-3-haiku-20240307 --protocol anthropic-messages --display-name "Claude Haiku" --max-context-tokens 200000
  agent-cli models add --provider my-local --model llama3 --protocol openai-compatible --no-usage
  agent-cli models remove anthropic claude-3-haiku-20240307
`)
}
