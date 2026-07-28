import { createLocalToolProvider, inspectLocalToolManifest } from "../../adapters/local/local-tool-provider.js"
import { loadConfig } from "../../core/config/config-loader.js"
import { createRuntime } from "../../core/runtime.js"

export async function toolsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args
  if (subcommand === "inspect") {
    const manifestPath = rest[0]
    if (!manifestPath) throw new Error("Usage: agent-cli tools inspect <manifest>")
    const inspected = await inspectLocalToolManifest(manifestPath)
    process.stdout.write(`${JSON.stringify({
      manifest: inspected.manifest,
      manifestPath: inspected.manifestPath,
      extensionRoot: inspected.extensionRoot,
      entryPath: inspected.entryPath,
      codeExecuted: false,
    }, null, 2)}\n`)
    return
  }
  if (subcommand === "list") {
    const manifests = parseAllowedManifests(rest)
    const cwd = process.cwd()
    const config = await loadConfig({ cwd })
    const providers = await Promise.all(manifests.map((manifestPath) =>
      createLocalToolProvider({ manifestPath, trusted: true }),
    ))
    const runtime = await createRuntime({ config, cwd, toolProviders: providers })
    try {
      process.stdout.write(`${JSON.stringify(runtime.tools.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        providerId: tool.metadata.providerId,
        provenance: tool.metadata.provenance,
        capabilities: tool.metadata.capabilities,
      })), null, 2)}\n`)
    } finally {
      await runtime.dispose()
    }
    return
  }
  throw new Error("Usage: agent-cli tools inspect <manifest> | tools list [--allow-local-extension <manifest>]")
}

function parseAllowedManifests(args: string[]): string[] {
  const manifests: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--allow-local-extension" || !args[index + 1]) {
      throw new Error(`Unknown tools list argument: ${args[index] ?? ""}`)
    }
    manifests.push(args[index + 1] as string)
    index += 1
  }
  return manifests
}
