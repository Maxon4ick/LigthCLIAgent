import { BadRequestError, NotFoundError } from "../../shared/errors.js"
import { createId } from "../../shared/ids.js"
import { redactMessageParts } from "../security/redaction.js"
import { readJsonFile, resolveWorkspacePath, updateJsonFile } from "../storage/atomic-json-file.js"
import type { Message, Session } from "./message-types.js"
import type {
  AddMessageInput,
  CompactSessionInput,
  CompactSessionResult,
  CreateSessionInput,
  ForkSessionInput,
  SessionStore,
  UpdateSessionPatch,
} from "./session-store.js"

interface SessionStoreFile {
  version: 2
  sessions: Session[]
  messages: Message[]
}

export class FileSessionStore implements SessionStore {
  private data: SessionStoreFile

  constructor(private readonly filePath: string) {
    this.data = loadStoreFile(filePath)
  }

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

    return this.writeLocked((data) => {
      data.sessions.push(session)
      return session
    })
  }

  listSessions(): Session[] {
    const data = this.refresh()
    return [...data.sessions].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  getSession(sessionId: string): Session {
    return findSession(this.refresh(), sessionId)
  }

  updateStatus(sessionId: string, status: Session["status"]): Session {
    return this.writeLocked((data) => {
      const session = findSession(data, sessionId)
      const next: Session = {
        ...session,
        status,
        updatedAt: new Date().toISOString(),
      }
      data.sessions = data.sessions.map((item) => (item.id === sessionId ? next : item))
      return next
    })
  }

  updateSession(sessionId: string, patch: UpdateSessionPatch): Session {
    return this.writeLocked((data) => {
      const session = findSession(data, sessionId)
      const next: Session = {
        ...session,
        ...patch,
        updatedAt: new Date().toISOString(),
      }

      data.sessions = data.sessions.map((item) => (item.id === sessionId ? next : item))
      return next
    })
  }

  forkSession(sessionId: string, input: ForkSessionInput = {}): Session {
    return this.writeLocked((data) => {
      const source = findSession(data, sessionId)
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

      const forkedMessages = data.messages
        .filter((message) => message.sessionId === sessionId)
        .map((message) => ({
          ...message,
          id: createId("msg"),
          sessionId: fork.id,
          createdAt: now,
        }))

      data.sessions.push(fork)
      data.messages.push(...forkedMessages)
      return fork
    })
  }

  compactSession(sessionId: string, input: CompactSessionInput): CompactSessionResult {
    return this.writeLocked((data) => {
      const currentSession = findSession(data, sessionId)
      const messages = data.messages.filter((message) => message.sessionId === sessionId)
      const keep = Math.max(0, input.keepLastMessages)
      const keptMessages = keep === 0 ? [] : messages.slice(-keep)
      const keptIds = new Set(keptMessages.map((message) => message.id))
      data.messages = data.messages.filter((message) => message.sessionId !== sessionId || keptIds.has(message.id))

      const session: Session = {
        ...currentSession,
        summary: input.summary,
        metadata: {
          ...(currentSession.metadata ?? {}),
          compactedAt: new Date().toISOString(),
          compactedMessageCount: messages.length - keptMessages.length,
        },
        updatedAt: new Date().toISOString(),
      }
      data.sessions = data.sessions.map((item) => (item.id === sessionId ? session : item))

      return {
        session,
        removedMessages: messages.length - keptMessages.length,
      }
    })
  }

  addMessage(input: AddMessageInput): Message {
    const message: Message = {
      id: createId("msg"),
      sessionId: input.sessionId,
      role: input.role,
      parts: redactMessageParts(input.parts),
      createdAt: new Date().toISOString(),
      usage: input.usage,
    }

    return this.writeLocked((data) => {
      findSession(data, input.sessionId)
      data.messages.push(message)
      return message
    })
  }

  listMessages(sessionId: string): Message[] {
    const data = this.refresh()
    findSession(data, sessionId)
    return data.messages.filter((message) => message.sessionId === sessionId)
  }

  clearMessages(sessionId: string): void {
    this.writeLocked((data) => {
      findSession(data, sessionId)
      data.messages = data.messages.filter((message) => message.sessionId !== sessionId)
    })
  }

  deleteSession(sessionId: string): void {
    this.writeLocked((data) => {
      findSession(data, sessionId)
      data.sessions = data.sessions.filter((session) => session.id !== sessionId)
      data.messages = data.messages.filter((message) => message.sessionId !== sessionId)
    })
  }

  private refresh(): SessionStoreFile {
    this.data = loadStoreFile(this.filePath)
    return this.data
  }

  private writeLocked<T>(mutate: (data: SessionStoreFile) => T): T {
    return updateJsonFile(this.filePath, emptyStore, parseStoreFile, (latest) => {
      const result = mutate(latest)
      this.data = latest
      return result
    })
  }
}

function findSession(data: SessionStoreFile, sessionId: string): Session {
  const session = data.sessions.find((item) => item.id === sessionId)
  if (!session) {
    throw new NotFoundError(`Session ${sessionId}`)
  }

  return session
}

export function resolveStorePath(cwd: string, configuredPath: string): string {
  return resolveWorkspacePath(cwd, configuredPath, "Session storage path")
}

function loadStoreFile(filePath: string): SessionStoreFile {
  return readJsonFile(filePath, emptyStore, parseStoreFile)
}

function emptyStore(): SessionStoreFile {
  return { version: 2, sessions: [], messages: [] }
}

function parseStoreFile(value: unknown): SessionStoreFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestError("Session store file must contain an object")
  }

  const record = value as Record<string, unknown>
  if (record.version !== 1 && record.version !== 2) {
    throw new BadRequestError("Unsupported session store version")
  }

  if (!Array.isArray(record.sessions) || !Array.isArray(record.messages)) {
    throw new BadRequestError("Session store file must contain sessions and messages arrays")
  }

  return {
    version: 2,
    sessions: (record.sessions as Session[]).map(normalizeSession),
    messages: record.messages as Message[],
  }
}

function normalizeSession(session: Session): Session {
  return {
    ...session,
    mode: session.mode ?? "build",
  }
}
