import type { MessagePart } from "../session/message-types.js"

export const REDACTED_SECRET = "[REDACTED_SECRET]"

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
]

const ENV_ASSIGNMENT =
  /(^|\n)([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*([^\r\n]+)/gi
const JSON_SECRET_FIELD =
  /("(?:apiKey|api_key|token|access_token|secret|password|privateKey|private_key)"\s*:\s*")([^"]+)(")/gi

export function redactSecrets(text: string): string {
  let redacted = text.replace(ENV_ASSIGNMENT, (_match, prefix: string, key: string) => {
    return `${prefix}${key}=${REDACTED_SECRET}`
  })

  redacted = redacted.replace(JSON_SECRET_FIELD, `$1${REDACTED_SECRET}$3`)

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED_SECRET)
  }

  return redacted
}

export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item))
  }

  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? REDACTED_SECRET : redactValue(nestedValue)
    }
    return output
  }

  return value
}

export function redactMessageParts(parts: MessagePart[]): MessagePart[] {
  return parts.map((part) => {
    if (part.type === "text") {
      return { ...part, text: redactSecrets(part.text) }
    }

    if (part.type === "tool_call") {
      return { ...part, input: redactValue(part.input) }
    }

    return {
      ...part,
      output: redactValue(part.output),
      error: part.error === undefined ? undefined : redactSecrets(part.error),
    }
  })
}

function isSensitiveKey(key: string): boolean {
  return /(api[_-]?key|token|secret|password|private[_-]?key)/i.test(key)
}
