import type { IncomingMessage, ServerResponse } from "node:http"
import type { EventBus } from "../core/events/event-bus.js"
import type { AppEvent } from "../core/events/event-types.js"

export function writeSseStream(
  eventBus: EventBus,
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...corsHeaders(request),
  })

  for (const event of eventBus.history({ sessionId })) {
    writeEvent(response, event)
  }

  const unsubscribe = eventBus.subscribe((event) => writeEvent(response, event), { sessionId })
  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n")
  }, 15_000)

  request.on("close", () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
}

function corsHeaders(request: IncomingMessage): Record<string, string> {
  const origin = request.headers.origin
  const headers: Record<string, string> = {
    vary: "origin",
  }

  if (typeof origin === "string" && isAllowedCorsOrigin(origin)) {
    headers["access-control-allow-origin"] = origin
  }

  return headers
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

function writeEvent(response: ServerResponse, event: AppEvent): void {
  response.write(`id: ${event.id}\n`)
  response.write(`event: ${event.type}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
