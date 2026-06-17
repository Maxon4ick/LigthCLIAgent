import type { AppConfig, ModelRef } from "./config/schema.js"
import { EventBus } from "./events/event-bus.js"
import { createProviderAdapter, listModelCatalog, resolveModel } from "./llm/model-registry.js"
import { ApprovalMediator, FileRememberedApprovalRuleStore, resolveApprovalRulesPath } from "./permissions/approvals.js"
import { RulesetPermissionPolicy } from "./permissions/policy.js"
import { FileSessionStore, resolveStorePath } from "./session/file-session-store.js"
import { SqliteSessionStore } from "./session/sqlite-session-store.js"
import { InMemorySessionStore, type SessionStore } from "./session/session-store.js"
import type { Message, Session } from "./session/message-types.js"
import { SessionRunner, type SessionRunResult } from "./session/session-runner.js"
import { SqliteDatabase, resolveDbPath } from "./storage/sqlite-db.js"
import { FileToolOutputStore, resolveToolOutputPath } from "./tools/output-store.js"
import { createDefaultToolRegistry, type ToolRegistry } from "./tools/registry.js"
import { createId } from "../shared/ids.js"

export interface Runtime {
  config: AppConfig
  cwd: string
  events: EventBus
  sessions: SessionStore
  approvals: ApprovalMediator
  tools: ToolRegistry
  runner: SessionRunner
  runs: ActiveRunManager
  db?: SqliteDatabase
  models: {
    current: ReturnType<typeof resolveModel>
    catalog: ReturnType<typeof listModelCatalog>
  }
}

export function createRuntime(config: AppConfig, cwd: string): Runtime {
  const events = new EventBus()
  const db = config.storage.kind === "sqlite" ? new SqliteDatabase(resolveDbPath(cwd, config.storage.dbPath)) : undefined
  if (db) config = db.applyOverrides(config)
  const sessions = createSessionStore(config, cwd, db)
  const toolRegistry = createDefaultToolRegistry(config)
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
    basePolicy: permissionPolicy,
    eventBus: events,
    timeoutMs: config.permissions.approvalTimeoutMs,
    rememberedApprovals,
  })
  const outputStore = new FileToolOutputStore(
    resolveToolOutputPath(cwd, config.toolOutput.path),
    cwd,
    config.toolOutput.retentionDays,
    config.toolOutput.maxStoredBytes,
  )

  const runner = new SessionRunner({
    store: sessions,
    eventBus: events,
    provider: createProviderAdapter(config),
    toolRegistry,
    permissionPolicy: approvals,
    config,
    outputStore,
  })
  const runs = new ActiveRunManager(runner, events, approvals)

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
    models: {
      current: resolveModel(config),
      catalog: listModelCatalog(config),
    },
  }
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
      .then(() => {
        this.events.publish({
          type: "session.run.finished",
          payload: {
            sessionId,
            runId,
            status: controller.signal.aborted ? "cancelled" : "completed",
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
      this.approvals.denyPendingForSession(sessionId)
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

function createSessionStore(config: AppConfig, cwd: string, db?: SqliteDatabase): SessionStore {
  if (config.storage.kind === "memory") {
    return new InMemorySessionStore()
  }

  if (config.storage.kind === "sqlite" && db) {
    return new SqliteSessionStore(db.db)
  }

  return new FileSessionStore(resolveStorePath(cwd, config.storage.path))
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
  if (options.baseUrl) runtime.config.providers.openaiCompatible.baseUrl = options.baseUrl
  if (options.apiKey) runtime.config.providers.openaiCompatible.apiKey = options.apiKey

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
  const provider = createProviderAdapter(runtime.config)
  runtime.runner.setProvider(provider)

  const session = runtime.sessions.updateSession(sessionId, { model: ref })
  runtime.models.current = resolveModel(runtime.config)
  runtime.models.catalog = listModelCatalog(runtime.config)

  runtime.events.publish({ type: "session.updated", payload: { sessionId, session } })
  return session
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
