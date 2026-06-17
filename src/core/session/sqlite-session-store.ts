import type BetterSqlite3 from "better-sqlite3"
import { NotFoundError } from "../../shared/errors.js"
import { createId } from "../../shared/ids.js"
import { redactMessageParts } from "../security/redaction.js"
import type { Message, Session, SessionStatus, TodoItem, TokenUsage } from "./message-types.js"
import type {
  AddMessageInput,
  CompactSessionInput,
  CompactSessionResult,
  CreateSessionInput,
  ForkSessionInput,
  SessionStore,
  UpdateSessionPatch,
} from "./session-store.js"

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: BetterSqlite3.Database) {}

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

    this.db
      .prepare(
        `INSERT INTO sessions
           (id, cwd, status, model_provider, model_model, agent_id, mode,
            title, parent_session_id, summary, todos, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.cwd,
        session.status,
        session.model.provider,
        session.model.model,
        session.agentId,
        session.mode,
        session.title ?? null,
        session.parentSessionId ?? null,
        session.summary ?? null,
        session.todos ? JSON.stringify(session.todos) : null,
        session.metadata ? JSON.stringify(session.metadata) : null,
        session.createdAt,
        session.updatedAt,
      )

    return session
  }

  listSessions(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY created_at ASC").all() as RawSession[]).map(rowToSession)
  }

  getSession(sessionId: string): Session {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as RawSession | undefined
    if (!row) throw new NotFoundError(`Session ${sessionId}`)
    return rowToSession(row)
  }

  updateStatus(sessionId: string, status: SessionStatus): Session {
    const now = new Date().toISOString()
    const info = this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, sessionId)
    if (info.changes === 0) throw new NotFoundError(`Session ${sessionId}`)
    return this.getSession(sessionId)
  }

  updateSession(sessionId: string, patch: UpdateSessionPatch): Session {
    const current = this.getSession(sessionId)
    const now = new Date().toISOString()
    const next: Session = { ...current, ...patch, updatedAt: now }

    this.db
      .prepare(
        `UPDATE sessions SET
           mode = ?, model_provider = ?, model_model = ?,
           title = ?, summary = ?, todos = ?, metadata = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.mode,
        next.model.provider,
        next.model.model,
        next.title ?? null,
        next.summary ?? null,
        next.todos ? JSON.stringify(next.todos) : null,
        next.metadata ? JSON.stringify(next.metadata) : null,
        now,
        sessionId,
      )

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

    const doFork = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions
             (id, cwd, status, model_provider, model_model, agent_id, mode,
              title, parent_session_id, summary, todos, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fork.id,
          fork.cwd,
          fork.status,
          fork.model.provider,
          fork.model.model,
          fork.agentId,
          fork.mode,
          fork.title ?? null,
          fork.parentSessionId ?? null,
          fork.summary ?? null,
          fork.todos ? JSON.stringify(fork.todos) : null,
          fork.metadata ? JSON.stringify(fork.metadata) : null,
          fork.createdAt,
          fork.updatedAt,
        )

      const sourceMessages = this.db
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
        .all(sessionId) as RawMessage[]

      const insertMsg = this.db.prepare(
        `INSERT INTO messages (id, session_id, role, parts, usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const msg of sourceMessages) {
        insertMsg.run(createId("msg"), fork.id, msg.role, msg.parts, msg.usage, now)
      }
    })

    doFork()
    return fork
  }

  compactSession(sessionId: string, input: CompactSessionInput): CompactSessionResult {
    const doCompact = this.db.transaction((): CompactSessionResult => {
      const current = this.getSession(sessionId)
      const messages = this.db
        .prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY created_at ASC")
        .all(sessionId) as { id: string }[]

      const keep = Math.max(0, input.keepLastMessages)
      const toDelete = keep === 0 ? messages : messages.slice(0, messages.length - keep)
      const removedCount = toDelete.length

      if (toDelete.length > 0) {
        const ids = toDelete.map((m) => m.id)
        const placeholders = ids.map(() => "?").join(",")
        this.db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids)
      }

      const now = new Date().toISOString()
      const metadata = {
        ...(current.metadata ?? {}),
        compactedAt: now,
        compactedMessageCount: removedCount,
      }

      const session = this.updateSession(sessionId, {
        summary: input.summary,
        metadata,
      })

      return { session, removedMessages: removedCount }
    })

    return doCompact()
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

    this.db
      .prepare(
        "INSERT INTO messages (id, session_id, role, parts, usage, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        JSON.stringify(message.parts),
        message.usage ? JSON.stringify(message.usage) : null,
        message.createdAt,
      )

    return message
  }

  listMessages(sessionId: string): Message[] {
    this.getSession(sessionId)
    return (
      this.db
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
        .all(sessionId) as RawMessage[]
    ).map(rowToMessage)
  }

  clearMessages(sessionId: string): void {
    this.getSession(sessionId)
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId)
  }

  deleteSession(sessionId: string): void {
    this.getSession(sessionId)
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId)
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId)
  }
}

// --- Row types ---

interface RawSession {
  id: string
  cwd: string
  status: string
  model_provider: string
  model_model: string
  agent_id: string
  mode: string
  title: string | null
  parent_session_id: string | null
  summary: string | null
  todos: string | null
  metadata: string | null
  created_at: string
  updated_at: string
}

interface RawMessage {
  id: string
  session_id: string
  role: string
  parts: string
  usage: string | null
  created_at: string
}

function rowToSession(row: RawSession): Session {
  return {
    id: row.id,
    cwd: row.cwd,
    status: row.status as SessionStatus,
    model: { provider: row.model_provider, model: row.model_model },
    agentId: row.agent_id,
    mode: row.mode as Session["mode"],
    title: row.title ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    summary: row.summary ?? undefined,
    todos: row.todos ? (JSON.parse(row.todos) as TodoItem[]) : undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToMessage(row: RawMessage): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as Message["role"],
    parts: JSON.parse(row.parts) as Message["parts"],
    usage: row.usage ? (JSON.parse(row.usage) as TokenUsage) : undefined,
    createdAt: row.created_at,
  }
}
