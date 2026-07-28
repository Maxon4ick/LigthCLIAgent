import type { Capability } from "../../core/permissions/policy.js"
import { redactSecrets } from "../../core/security/redaction.js"
import { normalizeIdentifier } from "../../core/tools/registry.js"
import type {
  ToolDefinition,
  ToolProvider,
  ToolProviderContext,
  ToolResult,
} from "../../core/tools/tool.js"

export interface McpServerConfig {
  id: string
  transport: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
  envFrom?: Record<string, string>
  cwd?: string
  startupTimeoutMs?: number
  toolTimeoutMs?: number
  enabled?: boolean
  toolCapabilities?: Record<string, Capability[]>
}

export interface McpToolDescription {
  name: string
  description?: string
  inputSchema: unknown
}

export interface McpClientLike {
  connect(config: McpServerConfig, signal: AbortSignal): Promise<void>
  listTools(signal: AbortSignal): Promise<McpToolDescription[]>
  callTool(name: string, input: unknown, signal: AbortSignal): Promise<unknown>
  close(): Promise<void> | void
}

export type McpClientFactory = (config: McpServerConfig) => Promise<McpClientLike> | McpClientLike

export interface McpToolProviderOptions {
  config: McpServerConfig
  clientFactory?: McpClientFactory
}

export class McpToolProvider implements ToolProvider {
  readonly id: string
  readonly provenance = "mcp" as const
  readonly failureMode = "isolate" as const
  readonly requiresExplicitCapabilities = true
  readonly namespace: string
  private client?: McpClientLike
  private disposed = false

  constructor(private readonly options: McpToolProviderOptions) {
    this.id = normalizeIdentifier(options.config.id, "MCP server id")
    this.namespace = `mcp__${this.id}`
  }

  async load(context: ToolProviderContext): Promise<ToolDefinition[]> {
    if (this.options.config.enabled !== true) return []
    const client = await (this.options.clientFactory ?? createOfficialMcpClient)(this.resolvedConfig())
    this.client = client
    try {
      await withSignalTimeout(
        (signal) => client.connect(this.resolvedConfig(), signal),
        context.abortSignal,
        this.options.config.startupTimeoutMs ?? 10_000,
        `MCP server "${this.id}" startup`,
      )
      const tools = await withSignalTimeout(
        (signal) => client.listTools(signal),
        context.abortSignal,
        this.options.config.startupTimeoutMs ?? 10_000,
        `MCP server "${this.id}" tool discovery`,
      )
      const names = new Set<string>()
      return tools.map((tool) => {
        const name = normalizeIdentifier(tool.name, "MCP tool name", 64)
        if (names.has(name)) throw new Error(`Duplicate MCP tool name "${name}"`)
        names.add(name)
        const capabilities = this.options.config.toolCapabilities?.[tool.name] ?? ["external.invoke"]
        return {
          name,
          description: tool.description?.trim() || `Invoke MCP tool ${tool.name}`,
          inputSchema: tool.inputSchema,
          kind: "other",
          metadata: {
            capabilities,
            safeConcurrent: false,
            mutatesWorkspace: false,
            requiresApproval: true,
            tags: ["mcp", this.id],
          },
          execute: async (input, toolContext): Promise<ToolResult> => {
            try {
              const output = await withSignalTimeout(
                (signal) => client.callTool(tool.name, input, signal),
                toolContext.abortSignal,
                this.options.config.toolTimeoutMs ?? 30_000,
                `MCP tool "${this.id}/${tool.name}"`,
              )
              return { ok: true, output }
            } catch (error) {
              return { ok: false, error: redactSecrets(safeError(error)) }
            }
          },
        } satisfies ToolDefinition
      })
    } catch (error) {
      try {
        await client.close()
      } catch {
        // The initialization error remains authoritative.
      }
      this.client = undefined
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.client?.close()
    this.client = undefined
  }

  private resolvedConfig(): McpServerConfig {
    const config = this.options.config
    const resolvedEnv = Object.fromEntries(
      Object.entries(config.envFrom ?? {}).map(([key, environmentName]) => {
        const value = process.env[environmentName]
        if (value === undefined) throw new Error(`Missing environment variable "${environmentName}" for MCP server "${this.id}"`)
        return [key, value]
      }),
    )
    return { ...config, env: { ...config.env, ...resolvedEnv } }
  }
}

async function createOfficialMcpClient(config: McpServerConfig): Promise<McpClientLike> {
  let clientModule: Record<string, unknown>
  let transportModule: Record<string, unknown>
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as
      (specifier: string) => Promise<Record<string, unknown>>
    ;[clientModule, transportModule] = await Promise.all([
      dynamicImport("@modelcontextprotocol/sdk/client/index.js"),
      dynamicImport("@modelcontextprotocol/sdk/client/stdio.js"),
    ])
  } catch {
    throw new Error(
      "The optional @modelcontextprotocol/sdk package is required to use the MCP adapter",
    )
  }
  const Client = clientModule.Client as new (...args: unknown[]) => {
    connect(transport: unknown): Promise<void>
    listTools(): Promise<{ tools?: McpToolDescription[] }>
    callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>
    close(): Promise<void>
  }
  const StdioClientTransport = transportModule.StdioClientTransport as new (options: unknown) => unknown
  const client = new Client({ name: "agent-cli", version: "0.1.0" }, { capabilities: {} })
  let transport: unknown
  return {
    async connect(server) {
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: server.env,
        cwd: server.cwd,
      })
      await client.connect(transport)
    },
    async listTools() {
      return (await client.listTools()).tools ?? []
    },
    async callTool(name, input) {
      return client.callTool({
        name,
        arguments: isRecord(input) ? input : { input },
      })
    },
    async close() {
      await client.close()
    },
  }
}

async function withSignalTimeout<T>(
  action: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(parentSignal.reason)
  parentSignal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error(`${label} aborted`))
        }, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    parentSignal.removeEventListener("abort", abort)
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
