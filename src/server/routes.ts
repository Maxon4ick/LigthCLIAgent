import type { IncomingMessage, ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { AppError, BadRequestError, errorToJson, NotFoundError, UnauthorizedError } from "../shared/errors.js"
import {
  addUserPrompt,
  compactSession,
  createSession,
  forkSession,
  renameSession,
  updateSessionMode,
  type Runtime,
} from "../core/runtime.js"
import { normalizePromptFileMentions } from "../core/context/file-mentions.js"
import { listSessionSnapshots, revertSessionSnapshots } from "../core/session/file-snapshots.js"
import type { AgentMode } from "../core/config/schema.js"
import { writeSseStream } from "./sse.js"

function capabilities(runtime: Runtime): { v: 1; features: string[] } {
  const features = [
    "health",
    "capabilities",
    "session_create",
    "session_prompt",
    "session_events",
    "session_fork",
    "session_compact",
    "session_diff",
    "session_revert",
    "session_abort",
    "run_ids",
    "event_schema_v1",
    "tool_discovery",
    "model_catalog",
    "openapi_schema",
    "mock_provider",
    "openai_compatible_provider",
    "anthropic_messages_provider",
    "gemini_provider",
    "apply_patch_tool",
    "safe_edit_pipeline",
    "audit_log",
    "permission_approval",
  ]

  if (runtime.config.server.authToken) {
    features.push("bearer_auth")
  }

  return {
    v: 1,
    features,
  }
}

export async function handleRoutes(runtime: Runtime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost")
    const method = request.method ?? "GET"
    const parts = url.pathname.split("/").filter(Boolean)

    if (method === "OPTIONS") {
      writeEmpty(response, 204, request)
      return
    }

    if (method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true }, request)
      return
    }

    if (method === "GET" && url.pathname === "/capabilities") {
      writeJson(response, 200, capabilities(runtime), request)
      return
    }

    requireSessionRouteAuth(runtime, request)

    if (method === "GET" && url.pathname === "/tools") {
      writeJson(response, 200, { tools: runtime.tools.list() }, request)
      return
    }

    if (method === "GET" && url.pathname === "/models") {
      writeJson(response, 200, { current: runtime.models.current, models: runtime.models.catalog }, request)
      return
    }

    if (method === "GET" && url.pathname === "/openapi.json") {
      writeJson(response, 200, openApiSchema(runtime), request)
      return
    }

    if (method === "POST" && url.pathname === "/sessions") {
      const body = await readJson(request)
      const session = createSession(runtime, {
        agentId: readOptionalString(body.agentId, "agentId"),
        mode: readOptionalAgentMode(body.mode, "mode"),
        title: readOptionalString(body.title, "title"),
      })
      writeJson(response, 201, { session }, request)
      return
    }

    if (method === "GET" && url.pathname === "/sessions") {
      writeJson(response, 200, { sessions: runtime.sessions.listSessions() }, request)
      return
    }

    if (parts[0] === "sessions" && parts[1]) {
      const sessionId = parts[1]

      if (method === "GET" && parts.length === 2) {
        writeJson(response, 200, {
          session: runtime.sessions.getSession(sessionId),
          messages: runtime.sessions.listMessages(sessionId),
        }, request)
        return
      }

      if (method === "PATCH" && parts.length === 2) {
        const body = await readJson(request)
        let session = runtime.sessions.getSession(sessionId)

        if (body.title !== undefined) {
          session = renameSession(runtime, sessionId, readRequiredString(body.title, "title"))
        }
        if (body.mode !== undefined) {
          session = updateSessionMode(runtime, sessionId, readAgentMode(body.mode, "mode"))
        }

        writeJson(response, 200, { session }, request)
        return
      }

      if (method === "DELETE" && parts.length === 2) {
        runtime.sessions.deleteSession(sessionId)
        writeJson(response, 200, { deleted: true, sessionId }, request)
        return
      }

      if (method === "POST" && parts.length === 3 && parts[2] === "fork") {
        runtime.sessions.getSession(sessionId)
        const body = await readJson(request)
        const session = forkSession(runtime, sessionId, {
          title: readOptionalString(body.title, "title"),
          mode: readOptionalAgentMode(body.mode, "mode"),
        })
        writeJson(response, 201, { session }, request)
        return
      }

      if (method === "POST" && parts.length === 3 && parts[2] === "compact") {
        runtime.sessions.getSession(sessionId)
        const body = await readJson(request)
        const result = compactSession(runtime, sessionId, {
          summary: readOptionalString(body.summary, "summary"),
          keepLastMessages: readOptionalPositiveInteger(body.keepLastMessages, "keepLastMessages"),
        })
        writeJson(response, 200, result, request)
        return
      }

      if (method === "GET" && parts.length === 3 && parts[2] === "diff") {
        runtime.sessions.getSession(sessionId)
        writeJson(response, 200, { snapshots: await listSessionSnapshots(runtime.cwd, sessionId) }, request)
        return
      }

      if (method === "POST" && parts.length === 3 && parts[2] === "revert") {
        runtime.sessions.getSession(sessionId)
        const body = await readJson(request)
        const results = await revertSessionSnapshots(runtime.cwd, sessionId, {
          snapshotId: readOptionalString(body.snapshotId, "snapshotId"),
          force: readOptionalBoolean(body.force, "force"),
        })
        writeJson(response, 200, { results }, request)
        return
      }

      if (method === "POST" && parts.length === 3 && parts[2] === "abort") {
        runtime.sessions.getSession(sessionId)
        const body = await readJson(request)
        const runId = readOptionalString(body.runId, "runId")
        const activeRun = runtime.runs.abort(sessionId, runId, "http abort")
        if (!activeRun) {
          throw new NotFoundError(runId ? `Run ${runId}` : `Active run for session ${sessionId}`)
        }
        writeJson(response, 202, { aborted: true, sessionId, runId: activeRun.runId }, request)
        return
      }

      if (method === "DELETE" && parts.length === 3 && parts[2] === "messages") {
        runtime.sessions.clearMessages(sessionId)
        writeJson(response, 200, { cleared: true, sessionId }, request)
        return
      }

      if (method === "POST" && parts.length === 3 && parts[2] === "prompt") {
        const body = await readJson(request)
        if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
          throw new BadRequestError("prompt must be a non-empty string")
        }

        runtime.sessions.getSession(sessionId)
        if (runtime.runs.get(sessionId)) {
          throw new BadRequestError(`Session ${sessionId} already has an active run`)
        }
        const normalizedPrompt = await normalizePromptFileMentions(runtime.cwd, body.prompt)
        addUserPrompt(runtime, sessionId, normalizedPrompt.prompt)
        const run = runtime.runs.start(sessionId)
        void run.promise.catch((error) => {
          runtime.events.publish({
            type: "session.error",
            payload: {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        })

        writeJson(response, 202, { accepted: true, sessionId, runId: run.runId, fileMentions: normalizedPrompt.mentions }, request)
        return
      }

      if (method === "GET" && parts.length === 3 && parts[2] === "permissions") {
        runtime.sessions.getSession(sessionId)
        writeJson(response, 200, { permissions: runtime.approvals.listPending(sessionId) }, request)
        return
      }

      if (method === "POST" && parts.length === 4 && parts[2] === "permissions") {
        runtime.sessions.getSession(sessionId)
        const approvalId = parts[3]
        const body = await readJson(request)
        if (
          body.decision !== "allow" &&
          body.decision !== "deny" &&
          body.decision !== "once" &&
          body.decision !== "always" &&
          body.decision !== "reject"
        ) {
          throw new BadRequestError('decision must be "allow", "once", "always", "deny", or "reject"')
        }

        try {
          const approval = runtime.approvals.respond(approvalId, body.decision)
          writeJson(response, 200, { approval }, request)
        } catch {
          throw new NotFoundError(`Permission ${approvalId}`)
        }
        return
      }

      if (method === "GET" && parts.length === 3 && parts[2] === "events") {
        runtime.sessions.getSession(sessionId)
        writeSseStream(runtime.events, request, response, sessionId)
        return
      }
    }

    throw new NotFoundError(`${method} ${url.pathname}`)
  } catch (error) {
    const statusCode = error instanceof AppError ? error.statusCode : 500
    writeJson(response, statusCode, { error: errorToJson(error) }, request)
  }
}

function requireSessionRouteAuth(runtime: Runtime, request: IncomingMessage): void {
  const token = runtime.config.server.authToken
  if (!token) {
    return
  }

  if (!constantTimeEqual(request.headers.authorization ?? "", `Bearer ${token}`)) {
    throw new UnauthorizedError()
  }
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown, request: IncomingMessage): void {
  if (response.headersSent) {
    return
  }

  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(request),
  })
  response.end(`${JSON.stringify(value, null, 2)}\n`)
}

function writeEmpty(response: ServerResponse, statusCode: number, request: IncomingMessage): void {
  if (response.headersSent) {
    return
  }

  response.writeHead(statusCode, corsHeaders(request))
  response.end()
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request)
  if (raw.trim().length === 0) {
    return {}
  }

  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError("JSON body must be an object")
  }

  return parsed as Record<string, unknown>
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }

  return timingSafeEqual(leftBuffer, rightBuffer)
}

function corsHeaders(request: IncomingMessage): Record<string, string> {
  const origin = request.headers.origin
  const headers: Record<string, string> = {
    vary: "origin",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  }

  if (typeof origin === "string" && isAllowedCorsOrigin(origin)) {
    headers["access-control-allow-origin"] = origin
  }

  return headers
}

function openApiSchema(runtime: Runtime): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "agent-cli daemon",
      version: "1.0.0",
    },
    paths: {
      "/health": { get: { summary: "Health check" } },
      "/capabilities": { get: { summary: "Runtime capabilities" } },
      "/tools": { get: { summary: "List registered tools" } },
      "/models": { get: { summary: "List model catalog and active model" } },
      "/sessions": {
        get: { summary: "List sessions" },
        post: { summary: "Create a session" },
      },
      "/sessions/{sessionId}": {
        get: { summary: "Get a session and messages" },
        patch: { summary: "Update title or mode" },
        delete: { summary: "Delete a session" },
      },
      "/sessions/{sessionId}/prompt": { post: { summary: "Append a prompt and run the agent" } },
      "/sessions/{sessionId}/events": { get: { summary: "Stream typed SSE events" } },
      "/sessions/{sessionId}/permissions": { get: { summary: "List pending approvals" } },
      "/sessions/{sessionId}/permissions/{approvalId}": { post: { summary: "Resolve an approval" } },
      "/sessions/{sessionId}/fork": { post: { summary: "Fork a session" } },
      "/sessions/{sessionId}/compact": { post: { summary: "Compact old messages into a summary" } },
      "/sessions/{sessionId}/diff": { get: { summary: "List file edit snapshots" } },
      "/sessions/{sessionId}/revert": { post: { summary: "Revert file edit snapshots" } },
      "/sessions/{sessionId}/abort": { post: { summary: "Abort the active run for a session" } },
    },
    "x-agent-cli": {
      features: capabilities(runtime).features,
      tools: runtime.tools.list().map((tool) => tool.name),
      currentModel: runtime.models.current,
    },
  }
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestError(`${name} must be a non-empty string`)
  }
  return value
}

function readOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  return readRequiredString(value, name)
}

function readAgentMode(value: unknown, name: string): AgentMode {
  if (value === "build" || value === "plan" || value === "explore") {
    return value
  }
  throw new BadRequestError(`${name} must be build, plan, or explore`)
}

function readOptionalAgentMode(value: unknown, name: string): AgentMode | undefined {
  if (value === undefined) {
    return undefined
  }
  return readAgentMode(value, name)
}

function readOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new BadRequestError(`${name} must be a positive integer`)
  }
  return value
}

function readOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "boolean") {
    throw new BadRequestError(`${name} must be a boolean`)
  }
  return value
}

function isAllowedCorsOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin)
    const host = parsed.hostname.toLowerCase()
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
  } catch {
    return false
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      body += chunk
      if (body.length > 1_000_000) {
        reject(new BadRequestError("Request body is too large"))
        request.destroy()
      }
    })
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })
}
