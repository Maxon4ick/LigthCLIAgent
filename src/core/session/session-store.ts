import { NotFoundError } from "../../shared/errors.js"
import { createId } from "../../shared/ids.js"
import type { AgentMode, ModelRef } from "../config/schema.js"
import { redactMessageParts } from "../security/redaction.js"
import type { Message, MessagePart, Session, SessionStatus, TodoItem, TokenUsage } from "./message-types.js"

export interface CreateSessionInput {
  cwd: string
  model: ModelRef
  agentId?: string
  mode?: AgentMode
  title?: string
  parentSessionId?: string
}

export interface AddMessageInput {
  sessionId: string
  role: Message["role"]
  parts: MessagePart[]
  usage?: TokenUsage
}

export interface SessionStore {
  createSession(input: CreateSessionInput): Session
  listSessions(): Session[]
  getSession(sessionId: string): Session
  updateStatus(sessionId: string, status: SessionStatus): Session
  updateSession(sessionId: string, patch: UpdateSessionPatch): Session
  forkSession(sessionId: string, input?: ForkSessionInput): Session
  compactSession(sessionId: string, input: CompactSessionInput): CompactSessionResult
  addMessage(input: AddMessageInput): Message
  listMessages(sessionId: string): Message[]
  clearMessages(sessionId: string): void
  deleteSession(sessionId: string): void
}

export interface UpdateSessionPatch {
  mode?: AgentMode
  model?: ModelRef
  title?: string
  summary?: string
  todos?: TodoItem[]
  metadata?: Record<string, unknown>
}

export interface ForkSessionInput {
  title?: string
  mode?: AgentMode
}

export interface CompactSessionInput {
  summary: string
  keepLastMessages: number
}

export interface CompactSessionResult {
  session: Session
  removedMessages: number
}

export class InMemorySessionStore implements SessionStore {
  protected readonly sessions = new Map<string, Session>()
  protected readonly messages = new Map<string, Message[]>()

  createSession(input: CreateSessionInput): Session {
    const now = new Date().toISOString()
    const session: Session = {
      id: createId("ses"),
      cwd: input.cwd,
      status: "idle",
      model: input.model,
      agentId: input.agentId ?? "default",
      mode: input.mode ?? "build",
      title: input.title,
      parentSessionId: input.parentSessionId,
      createdAt: now,
      updatedAt: now,
    }

    this.sessions.set(session.id, session)
    this.messages.set(session.id, [])
    return session
  }

  listSessions(): Session[] {
    return [...this.sessions.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  getSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new NotFoundError(`Session ${sessionId}`)
    }

    return session
  }

  updateStatus(sessionId: string, status: SessionStatus): Session {
    const current = this.getSession(sessionId)
    const next: Session = {
      ...current,
      status,
      updatedAt: new Date().toISOString(),
    }

    this.sessions.set(sessionId, next)
    return next
  }

  updateSession(sessionId: string, patch: UpdateSessionPatch): Session {
    const current = this.getSession(sessionId)
    const next: Session = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    }

    this.sessions.set(sessionId, next)
    return next
  }

  forkSession(sessionId: string, input: ForkSessionInput = {}): Session {
    const source = this.getSession(sessionId)
    const now = new Date().toISOString()
    const fork: Session = {
      ...source,
      id: createId("ses"),
      status: "idle",
      mode: input.mode ?? source.mode,
      title: input.title ?? source.title,
      parentSessionId: source.id,
      createdAt: now,
      updatedAt: now,
    }

    this.sessions.set(fork.id, fork)
    this.messages.set(
      fork.id,
      this.listMessages(sessionId).map((message) => ({
        ...message,
        id: createId("msg"),
        sessionId: fork.id,
        createdAt: now,
      })),
    )
    return fork
  }

  compactSession(sessionId: string, input: CompactSessionInput): CompactSessionResult {
    const currentMessages = this.listMessages(sessionId)
    const keep = Math.max(0, input.keepLastMessages)
    const keptMessages = keep === 0 ? [] : currentMessages.slice(-keep)
    this.messages.set(sessionId, keptMessages)
    const session = this.updateSession(sessionId, {
      summary: input.summary,
      metadata: {
        ...(this.getSession(sessionId).metadata ?? {}),
        compactedAt: new Date().toISOString(),
        compactedMessageCount: currentMessages.length - keptMessages.length,
      },
    })

    return {
      session,
      removedMessages: currentMessages.length - keptMessages.length,
    }
  }

  addMessage(input: AddMessageInput): Message {
    this.getSession(input.sessionId)

    const message: Message = {
      id: createId("msg"),
      sessionId: input.sessionId,
      role: input.role,
      parts: redactMessageParts(input.parts),
      createdAt: new Date().toISOString(),
      usage: input.usage,
    }

    const messages = this.messages.get(input.sessionId)
    if (!messages) {
      throw new NotFoundError(`Session ${input.sessionId}`)
    }

    messages.push(message)
    return message
  }

  listMessages(sessionId: string): Message[] {
    this.getSession(sessionId)
    return [...(this.messages.get(sessionId) ?? [])]
  }

  clearMessages(sessionId: string): void {
    this.getSession(sessionId)
    this.messages.set(sessionId, [])
  }

  deleteSession(sessionId: string): void {
    this.getSession(sessionId)
    this.sessions.delete(sessionId)
    this.messages.delete(sessionId)
  }
}
