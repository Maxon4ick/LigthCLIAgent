import type { AppConfig, ModelRef } from "./config/schema.js"
import { EventBus, type EventListener, type SubscribeOptions } from "./events/event-bus.js"
import { createProviderAdapter, listModelCatalog, resolveModel } from "./llm/model-registry.js"
import { ApprovalMediator, FileRememberedApprovalRuleStore, resolveApprovalRulesPath } from "./permissions/approvals.js"
import { RulesetPermissionPolicy, type PermissionPolicy } from "./permissions/policy.js"
import { FileSessionStore, resolveStorePath } from "./session/file-session-store.js"
import { InMemorySessionStore, type SessionStore } from "./session/session-store.js"
import type { Message, Session } from "./session/message-types.js"
import { SessionRunner, type SessionRunResult, type Tokenizer } from "./session/session-runner.js"
import type { RuntimeStateStore, StorageAdapter } from "./storage/contracts.js"
import { FileRuntimeStateStore } from "./storage/file-runtime-state.js"
import { createAdapterStores, resolveStorageAdapter } from "./storage/registry.js"
import { MemoryRuntimeStateStore } from "./storage/runtime-state.js"
import { FileToolOutputStore, resolveToolOutputPath } from "./tools/output-store.js"
import { builtinToolProvider, loadToolProviders, ToolRegistry } from "./tools/registry.js"
import { createId } from "../shared/ids.js"
import type { ProviderAdapter } from "./llm/provider.js"
import type { ToolProvider } from "./tools/tool.js"
import { workspaceSkillSources, type SkillSource } from "./context/skills.js"
import {
  HookPipeline,
  type AgentHook,
  type HookProvider,
} from "./hooks/hooks.js"
import {
  DefaultContextBudgetManager,
  type ContextBudgetManager,
} from "./context/context-budget.js"

export interface Runtime {
  config: AppConfig
  cwd: string
  events: EventBus
  sessions: SessionStore
  approvals: ApprovalMediator
  tools: ToolRegistry
  runner: SessionRunner
  runs: ActiveRunManager
  /** @deprecated Use state. Present only for explicitly selected SQLite storage. */
  db?: LegacyRuntimeDatabase
  state: RuntimeStateStore
  models: {
    current: ReturnType<typeof resolveModel>
    catalog: ReturnType<typeof listModelCatalog>
  }
  ready: Promise<void>
  startSession(sessionId: string): ActiveRun
  stopSession(sessionId: string, reason?: string): boolean
  subscribe(listener: EventListener, options?: SubscribeOptions): () => void
  providerFor(model: ModelRef): ProviderAdapter
  dispose(): Promise<void>
}

export interface LegacyRuntimeDatabase {
  getApiKey(provider: string): string | undefined
  setApiKey(provider: string, apiKey: string): void
  deleteApiKey(provider: string): void
  listApiKeys(): Array<{ provider: string; updatedAt: string }>
  upsertCustomModel(entry: AppConfig["models"]["catalog"][number]): void
  deleteCustomModel(provider: string, model: string): void
  setProviderConfig(
    provider: string,
    config: {
      baseUrl: string
      protocol: AppConfig["models"]["catalog"][number]["protocol"]
      apiKeyEnv: string
    },
  ): void
  setActiveModel(ref: ModelRef): void
  close(): void
}

export type ProviderFactory = (model: ModelRef) => ProviderAdapter

export interface CreateRuntimeOptions {
  config: AppConfig
  cwd: string
  provider?: ProviderAdapter
  providerFactory?: ProviderFactory
  sessionStore?: SessionStore
  permissionPolicy?: PermissionPolicy
  eventBus?: EventBus
  toolProviders?: ToolProvider[]
  skillSources?: SkillSource[]
  hooks?: AgentHook[] | HookProvider[]
  contextBudget?: ContextBudgetManager
  tokenizer?: Tokenizer
  storageAdapters?: StorageAdapter[]
  runtimeState?: RuntimeStateStore
}

/** @deprecated Prefer the object-form CreateRuntimeOptions. */
export type RuntimeOptions = Omit<CreateRuntimeOptions, "config">

export function createRuntime(options: CreateRuntimeOptions): Promise<Runtime>
export function createRuntime(config: AppConfig, cwd: string): Runtime
export function createRuntime(config: AppConfig, options: RuntimeOptions): Runtime
export function createRuntime(
  configOrOptions: AppConfig | CreateRuntimeOptions,
  cwdOrOptions?: string | RuntimeOptions,
): Runtime | Promise<Runtime> {
  if (isCreateRuntimeOptions(configOrOptions, cwdOrOptions)) {
    return createRuntimeAsync(configOrOptions)
  }
  const options: RuntimeOptions = typeof cwdOrOptions === "string"
    ? { cwd: cwdOrOptions }
    : cwdOrOptions as RuntimeOptions
  return constructRuntime(configOrOptions as AppConfig, options, options.hooks as AgentHook[] | undefined, false)
}

async function createRuntimeAsync(options: CreateRuntimeOptions): Promise<Runtime> {
  const lifecycleController = new AbortController()
  const resolved = await resolveHooks(options.hooks ?? [])
  let adapter: StorageAdapter | undefined
  let runtime: Runtime | undefined
  try {
    let sessions = options.sessionStore
    let state = options.runtimeState
    let config = options.config
    if (!sessions) {
      adapter = await resolveStorageAdapter(config, options.storageAdapters ?? [])
      const stores = await createAdapterStores(adapter, {
        cwd: options.cwd,
        config,
        signal: lifecycleController.signal,
      })
      sessions = stores.sessions
      state ??= stores.state
    }
    state ??= new MemoryRuntimeStateStore()
    config = state.applyOverrides(config)
    const { config: _originalConfig, ...runtimeOptions } = options
    runtime = constructRuntime(
      config,
      { ...runtimeOptions, sessionStore: sessions, runtimeState: state },
      resolved.hooks,
      true,
      resolved.providers,
      lifecycleController,
      adapter,
    )
    await runtime.ready
    return runtime
  } catch (error) {
    if (runtime) {
      try {
        await runtime.dispose()
      } catch {
        // Preserve the initialization error.
      }
      throw error
    }
    lifecycleController.abort(error)
    try {
      await adapter?.dispose?.()
    } catch {
      // Preserve the initialization error.
    }
    for (const provider of [...resolved.providers].reverse()) {
      try {
        await provider.dispose?.()
      } catch {
        // Preserve the initialization error.
      }
    }
    throw error
  }
}

function constructRuntime(
  config: AppConfig,
  options: RuntimeOptions,
  resolvedHooks: AgentHook[] = [],
  canonical = false,
  hookProviders: HookProvider[] = [],
  lifecycleController = new AbortController(),
  storageAdapter?: StorageAdapter,
): Runtime {
  const cwd = options.cwd
  const events = options.eventBus ?? new EventBus()
  const initializedToolProviders: ToolProvider[] = []
  let disposed = false
  const state = options.runtimeState ?? (
    config.storage.kind === "file"
      ? new FileRuntimeStateStore(cwd)
      : new MemoryRuntimeStateStore()
  )
  config = state.applyOverrides(config)
  if (!options.sessionStore && config.storage.kind === "sqlite") {
    throw new Error(
      "SQLite storage requires asynchronous initialization. Use await createRuntime({ config, cwd }).",
    )
  }
  const sessions = options.sessionStore ?? (
    config.storage.kind === "memory"
      ? new InMemorySessionStore()
      : new FileSessionStore(resolveStorePath(cwd, config.storage.path))
  )
  const db = storageAdapter?.legacyDatabase as LegacyRuntimeDatabase | undefined
  const skillSources = options.skillSources ?? workspaceSkillSources(config.agent.skillPaths)
  const hooks = new HookPipeline(resolvedHooks, events, config.extensions.hookTimeoutMs)
  const rememberedApprovals = new FileRememberedApprovalRuleStore(resolveApprovalRulesPath(cwd, config.permissions.approvalsPath))
  const permissionPolicy = new RulesetPermissionPolicy({
    allowShell: config.permissions.allowShell,
    allowEdit: config.permissions.allowEdit,
    askForShell: config.permissions.askForShell,
    askForEdit: config.permissions.askForEdit,
    allowNetwork: config.permissions.allowNetwork,
    askForNetwork: config.permissions.askForNetwork,
    rules: config.permissions.rules,
    rememberedRules: rememberedApprovals,
  })
  const approvals = new ApprovalMediator({
    basePolicy: options.permissionPolicy ?? permissionPolicy,
    eventBus: events,
    timeoutMs: config.permissions.approvalTimeoutMs,
    rememberedApprovals,
  })
  const toolRegistry = new ToolRegistry()
  const ready = loadToolProviders(
    toolRegistry,
    [builtinToolProvider, ...(options.toolProviders ?? [])],
    {
      cwd,
      config,
      events,
      permissions: approvals,
      abortSignal: lifecycleController.signal,
    },
    config.tools.disabledProviders,
    config.tools.disabled,
    initializedToolProviders,
  ).then(() => undefined)
  const outputStore = new FileToolOutputStore(
    resolveToolOutputPath(cwd, config.toolOutput.path),
    cwd,
    config.toolOutput.retentionDays,
    config.toolOutput.maxStoredBytes,
  )
  const providerFor = options.providerFactory ??
    (options.provider ? () => options.provider as ProviderAdapter : (model: ModelRef) => createProviderAdapter({ ...config, model }))

  const runner = new SessionRunner({
    store: sessions,
    eventBus: events,
    provider: options.provider ?? createProviderAdapter(config),
    providerFactory: providerFor,
    toolRegistry,
    permissionPolicy: approvals,
    config,
    outputStore,
    initialize: ready,
    skillSources,
    hooks,
    tokenizer: options.tokenizer,
    contextBudget: options.contextBudget ??
      (canonical ? new DefaultContextBudgetManager(undefined, undefined, events) : undefined),
  })
  const runs = new ActiveRunManager(runner, events, approvals, sessions)
  const provider = options.provider
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    lifecycleController.abort(new Error("Runtime disposed"))
    try {
      await ready
    } catch {
      // Initialization errors are reported to the createRuntime caller.
    }
    const errors: unknown[] = []
    for (const item of [...initializedToolProviders].reverse()) {
      try {
        await item.dispose?.()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const source of [...skillSources].reverse()) {
      try {
        await source.dispose?.()
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await hooks.dispose()
    } catch (error) {
      errors.push(error)
    }
    for (const hookProvider of [...hookProviders].reverse()) {
      try {
        await hookProvider.dispose?.()
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await provider?.dispose?.()
    } catch (error) {
      errors.push(error)
    }
    try {
      await storageAdapter?.dispose?.()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more runtime resources failed to dispose")
    }
  }

  return {
    config,
    cwd,
    events,
    sessions,
    approvals,
    tools: toolRegistry,
    runner,
    runs,
    db,
    state,
    models: {
      current: resolveModel(config),
      catalog: listModelCatalog(config),
    },
    ready,
    startSession: (sessionId) => runs.start(sessionId),
    stopSession: (sessionId, reason) => Boolean(runs.abort(sessionId, undefined, reason)),
    subscribe: (listener, subscribeOptions) => events.subscribe(listener, subscribeOptions),
    providerFor,
    dispose,
  }
}

function isCreateRuntimeOptions(
  value: AppConfig | CreateRuntimeOptions,
  second: string | RuntimeOptions | undefined,
): value is CreateRuntimeOptions {
  return second === undefined && typeof value === "object" && value !== null && "config" in value && "cwd" in value
}

async function resolveHooks(
  items: AgentHook[] | HookProvider[],
): Promise<{ hooks: AgentHook[]; providers: HookProvider[] }> {
  const hooks: AgentHook[] = []
  const providers: HookProvider[] = []
  try {
    for (const item of items) {
      if ("load" in item && typeof item.load === "function") {
        providers.push(item)
        hooks.push(...await item.load())
      } else {
        hooks.push(item as AgentHook)
      }
    }
  } catch (error) {
    for (const provider of providers.reverse()) {
      try {
        await provider.dispose?.()
      } catch {
        // Preserve the initialization error.
      }
    }
    throw error
  }
  return { hooks, providers }
}

export interface ActiveRun {
  runId: string
  sessionId: string
  startedAt: string
  promise: Promise<SessionRunResult>
}

export class ActiveRunManager {
  private readonly runs = new Map<string, ActiveRun & { controller: AbortController; startedAtMs: number }>()

  constructor(
    private readonly runner: SessionRunner,
    private readonly events: EventBus,
    private readonly approvals: ApprovalMediator,
    private readonly sessions: SessionStore,
  ) {}

  start(sessionId: string): ActiveRun {
    const existing = this.get(sessionId)
    if (existing) {
      throw new Error(`Session ${sessionId} already has active run ${existing.runId}`)
    }

    const runId = createId("run")
    const controller = new AbortController()
    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    this.events.publish({
      type: "session.run.started",
      payload: { sessionId, runId },
    })

    const promise = this.runner.run(sessionId, controller.signal)
    const active = { runId, sessionId, startedAt, promise, controller, startedAtMs }
    this.runs.set(sessionId, active)

    void promise
      .then((result) => {
        this.events.publish({
          type: "session.run.finished",
          payload: {
            sessionId,
            runId,
            status: result.stop.reason === "cancelled"
              ? "cancelled"
              : result.stop.reason === "completed" ? "completed" : "error",
            stopReason: result.stop.reason,
            durationMs: Date.now() - startedAtMs,
          },
        })
      })
      .catch(() => {
        this.events.publish({
          type: "session.run.finished",
          payload: {
            sessionId,
            runId,
            status: controller.signal.aborted ? "cancelled" : "error",
            stopReason: controller.signal.aborted ? "cancelled" : "error",
            durationMs: Date.now() - startedAtMs,
          },
        })
      })
      .finally(() => {
        if (this.runs.get(sessionId)?.runId === runId) {
          this.runs.delete(sessionId)
        }
      })

    return active
  }

  get(sessionId: string): ActiveRun | undefined {
    return this.runs.get(sessionId)
  }

  abort(sessionId: string, runId?: string, reason = "requested"): ActiveRun | undefined {
    const active = this.runs.get(sessionId)
    if (!active || (runId && active.runId !== runId)) {
      return undefined
    }

    if (!active.controller.signal.aborted) {
      active.controller.abort(new Error(reason))
      for (const pendingSessionId of new Set(this.approvals.listPending().map((approval) => approval.request.sessionId))) {
        if (isSessionOrDescendant(this.sessions, pendingSessionId, sessionId)) {
          this.approvals.denyPendingForSession(pendingSessionId)
        }
      }
      this.events.publish({
        type: "session.run.aborted",
        payload: { sessionId, runId: active.runId, reason },
      })
    }

    return active
  }

  list(sessionId?: string): ActiveRun[] {
    const runs = [...this.runs.values()]
    return (sessionId ? runs.filter((run) => run.sessionId === sessionId) : runs).map(({ controller: _controller, startedAtMs: _startedAtMs, ...run }) => run)
  }
}

function isSessionOrDescendant(store: SessionStore, candidateId: string, ancestorId: string): boolean {
  if (candidateId === ancestorId) return true
  const sessions = new Map(store.listSessions().map((session) => [session.id, session]))
  const visited = new Set<string>()
  let current = sessions.get(candidateId)
  while (current?.parentSessionId && !visited.has(current.parentSessionId)) {
    if (current.parentSessionId === ancestorId) return true
    visited.add(current.parentSessionId)
    current = sessions.get(current.parentSessionId)
  }
  return false
}

export function createSession(
  runtime: Runtime,
  options: { agentId?: string; mode?: AppConfig["agent"]["defaultMode"]; title?: string; parentSessionId?: string } = {},
): Session {
  const session = runtime.sessions.createSession({
    cwd: runtime.cwd,
    model: runtime.config.model,
    agentId: options.agentId,
    mode: options.mode ?? runtime.config.agent.defaultMode,
    title: options.title,
    parentSessionId: options.parentSessionId,
  })
  runtime.events.publish({
    type: "session.created",
    payload: { session },
  })
  return session
}

export function addUserPrompt(runtime: Runtime, sessionId: string, prompt: string): Message {
  const message = runtime.sessions.addMessage({
    sessionId,
    role: "user",
    parts: [{ type: "text", text: prompt }],
  })
  runtime.events.publish({
    type: "message.created",
    payload: { sessionId, message },
  })
  return message
}

export function forkSession(runtime: Runtime, sessionId: string, options: { title?: string; mode?: Session["mode"] } = {}): Session {
  const session = runtime.sessions.forkSession(sessionId, options)
  runtime.events.publish({
    type: "session.created",
    payload: { session },
  })
  return session
}

export function updateSessionMode(runtime: Runtime, sessionId: string, mode: Session["mode"]): Session {
  const session = runtime.sessions.updateSession(sessionId, { mode })
  runtime.events.publish({
    type: "session.updated",
    payload: { sessionId, session },
  })
  return session
}

export function renameSession(runtime: Runtime, sessionId: string, title: string): Session {
  const session = runtime.sessions.updateSession(sessionId, { title })
  runtime.events.publish({
    type: "session.updated",
    payload: { sessionId, session },
  })
  return session
}

export function compactSession(
  runtime: Runtime,
  sessionId: string,
  options: { summary?: string; keepLastMessages?: number } = {},
): { session: Session; removedMessages: number } {
  const messages = runtime.sessions.listMessages(sessionId)
  const summary = options.summary ?? summarizeMessages(messages)
  const result = runtime.sessions.compactSession(sessionId, {
    summary,
    keepLastMessages: options.keepLastMessages ?? runtime.config.agent.compactMaxMessages,
  })
  runtime.events.publish({
    type: "session.updated",
    payload: { sessionId, session: result.session },
  })
  return result
}

export interface SwitchModelOptions {
  baseUrl?: string
  apiKey?: string
}

export function switchModel(
  runtime: Runtime,
  sessionId: string,
  ref: ModelRef,
  options: SwitchModelOptions = {},
): Session {
  applyProviderConnectionOptions(runtime.config, ref.provider, options)

  const alreadyInCatalog = runtime.config.models.catalog.some(
    (entry) => entry.provider === ref.provider && entry.model === ref.model,
  )
  if (!alreadyInCatalog) {
    const protocol = ref.provider === "anthropic"
      ? "anthropic-messages" as const
      : ref.provider === "gemini"
      ? "gemini-generative-language" as const
      : "openai-compatible" as const
    runtime.config.models.catalog = [
      ...runtime.config.models.catalog,
      {
        provider: ref.provider,
        model: ref.model,
        protocol,
        capabilities: { tools: true, streaming: true, usage: true, reasoning: false, imageInput: false },
      },
    ]
  }

  runtime.config.model = ref
  const provider = runtime.providerFor(ref)
  runtime.runner.setProvider(provider)

  const session = runtime.sessions.updateSession(sessionId, { model: ref })
  runtime.state.setActiveModel(ref)
  runtime.models.current = resolveModel(runtime.config)
  runtime.models.catalog = listModelCatalog(runtime.config)

  runtime.events.publish({ type: "session.updated", payload: { sessionId, session } })
  return session
}

function applyProviderConnectionOptions(config: AppConfig, provider: string, options: SwitchModelOptions): void {
  if (!options.baseUrl && !options.apiKey) return

  if (provider === "anthropic") {
    if (options.baseUrl) config.providers.anthropic.baseUrl = options.baseUrl
    if (options.apiKey) config.providers.anthropic.apiKey = options.apiKey
    return
  }

  if (provider === "gemini") {
    if (options.baseUrl) config.providers.gemini.baseUrl = options.baseUrl
    if (options.apiKey) config.providers.gemini.apiKey = options.apiKey
    return
  }

  if (provider === "openai-compatible" || (isOpenAIAlias(provider) && !config.providers.custom[provider])) {
    if (options.baseUrl) config.providers.openaiCompatible.baseUrl = options.baseUrl
    if (options.apiKey) config.providers.openaiCompatible.apiKey = options.apiKey
    return
  }

  const existing = config.providers.custom[provider]
  config.providers.custom[provider] = {
    ...(existing ?? {
      protocol: "openai-compatible" as const,
      baseUrl: options.baseUrl ?? config.providers.openaiCompatible.baseUrl,
      apiKeyEnv: `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`,
    }),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  }
}

function isOpenAIAlias(provider: string): boolean {
  return provider === "openai" || provider === "openai-chat"
}

function summarizeMessages(messages: Message[]): string {
  const textMessages = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
      return text ? `${message.role}: ${text}` : undefined
    })
    .filter((value): value is string => value !== undefined)

  if (textMessages.length === 0) {
    return "No text messages were present before compaction."
  }

  const first = textMessages.slice(0, 3)
  const last = textMessages.slice(-5)
  const combined = [...first, ...(textMessages.length > 8 ? ["..."] : []), ...last].join("\n")
  return combined.slice(0, 8_000)
}
