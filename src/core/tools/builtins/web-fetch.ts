import type { ToolDefinition } from "../tool.js"

interface WebFetchInput {
  url: string
  method?: "GET" | "HEAD"
  maxBytes?: number
}

interface WebFetchOutput {
  url: string
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  truncated: boolean
}

const DEFAULT_MAX_BYTES = 50_000
const HARD_MAX_BYTES = 500_000

export const webFetchTool: ToolDefinition<unknown, WebFetchOutput> = {
  name: "web_fetch",
  description: "Fetch an HTTP(S) URL when network permission explicitly allows it.",
  kind: "network",
  metadata: {
    safeConcurrent: true,
    mutatesWorkspace: false,
    requiresApproval: true,
    tags: ["web", "network"],
  },
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      method: { type: "string", enum: ["GET", "HEAD"] },
      maxBytes: { type: "number" },
    },
  },
  async execute(input, context) {
    const parsed = parseInput(input)
    const response = await fetch(parsed.url, {
      method: parsed.method ?? "GET",
      signal: context.abortSignal,
      redirect: "follow",
    })
    const text = parsed.method === "HEAD" ? "" : await response.text()
    const maxBytes = parsed.maxBytes ?? Math.min(context.maxOutputBytes, DEFAULT_MAX_BYTES)
    const bounded = boundText(text, maxBytes)

    return {
      ok: true,
      output: {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: publicHeaders(response.headers),
        body: bounded.text,
        truncated: bounded.truncated,
      },
    }
  },
}

function parseInput(input: unknown): WebFetchInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("web_fetch input must be an object")
  }

  const record = input as Record<string, unknown>
  if (typeof record.url !== "string" || record.url.length === 0) {
    throw new Error("web_fetch.url must be a non-empty string")
  }

  const url = new URL(record.url)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch.url must be http or https")
  }

  if (record.method !== undefined && record.method !== "GET" && record.method !== "HEAD") {
    throw new Error('web_fetch.method must be "GET" or "HEAD"')
  }

  if (record.maxBytes !== undefined) {
    if (typeof record.maxBytes !== "number" || !Number.isInteger(record.maxBytes) || record.maxBytes <= 0) {
      throw new Error("web_fetch.maxBytes must be a positive integer")
    }
    if (record.maxBytes > HARD_MAX_BYTES) {
      throw new Error(`web_fetch.maxBytes must be <= ${HARD_MAX_BYTES}`)
    }
  }

  return {
    url: url.toString(),
    method: record.method,
    maxBytes: record.maxBytes,
  }
}

function publicHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    if (!["set-cookie", "authorization", "proxy-authorization"].includes(key.toLowerCase())) {
      result[key] = value
    }
  }
  return result
}

function boundText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false }
  }

  return { text: text.slice(0, maxBytes), truncated: true }
}
