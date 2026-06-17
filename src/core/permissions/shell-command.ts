export interface ShellCommandSegment {
  raw: string
  prefix: string
  approvalResource: string
  readOnly: boolean
  dangerous: boolean
}

const READ_ONLY_PREFIXES = [
  "dir",
  "git diff",
  "git log",
  "git show",
  "git status",
  "grep",
  "ls",
  "node --version",
  "npm --version",
  "npm run lint",
  "npm run test",
  "npm run typecheck",
  "npm test",
  "pnpm --version",
  "pnpm run lint",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm test",
  "pwd",
  "rg",
  "yarn --version",
  "yarn lint",
  "yarn run lint",
  "yarn run test",
  "yarn run typecheck",
  "yarn test",
]

const REMEMBERABLE_PREFIXES = [
  "git status",
  "npm run build",
  "npm run lint",
  "npm run test",
  "npm run typecheck",
  "npm test",
  "pnpm run build",
  "pnpm run lint",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm test",
  "yarn build",
  "yarn lint",
  "yarn run build",
  "yarn run lint",
  "yarn run test",
  "yarn run typecheck",
  "yarn test",
]

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\b/i,
  /\bdel\s+\/s\b/i,
  /\brmdir\s+\/s\b/i,
  /\bremove-item\b[\s\S]*\b-recurse\b/i,
  /\bformat\s+[a-z]:/i,
  /\bgit\s+reset\b[\s\S]*\b--hard\b/i,
  /\bgit\s+clean\b[\s\S]*\b-f\b/i,
]

export function classifyShellCommand(command: string): ShellCommandSegment[] {
  return splitShellCommandSegments(command).map((raw) => {
    const prefix = commandPrefix(raw)
    const dangerous = isDangerousShellSegment(raw)
    return {
      raw,
      prefix,
      approvalResource: commandApprovalResource(raw, prefix),
      readOnly: isReadOnlyPrefix(prefix) && !dangerous,
      dangerous,
    }
  })
}

export function commandPermissionResources(command: string): string[] {
  const segments = classifyShellCommand(command)
  return segments.length > 0 ? segments.map((segment) => segment.approvalResource) : [command.trim()]
}

export function isDangerousShellCommand(command: string): boolean {
  return classifyShellCommand(command).some((segment) => segment.dangerous) || readsSecretAndSendsNetwork(command)
}

export function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = []
  let quote: "'" | "\"" | "`" | undefined
  let start = 0

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    const next = command[index + 1]
    const previous = command[index - 1]

    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = undefined
      }
      continue
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char
      continue
    }

    if (char === "\n" || char === ";") {
      pushSegment(segments, command.slice(start, index))
      start = index + 1
      continue
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      pushSegment(segments, command.slice(start, index))
      index += 1
      start = index + 1
      continue
    }

    if (char === "|") {
      pushSegment(segments, command.slice(start, index))
      start = index + 1
    }
  }

  pushSegment(segments, command.slice(start))
  return segments
}

function pushSegment(segments: string[], raw: string): void {
  const trimmed = raw.trim()
  if (trimmed) {
    segments.push(trimmed)
  }
}

function commandApprovalResource(raw: string, prefix: string): string {
  const rememberable = REMEMBERABLE_PREFIXES.find((item) => prefix === item || prefix.startsWith(`${item} `))
  if (rememberable) {
    return `${rememberable}*`
  }

  return normalizeWhitespace(raw)
}

function isReadOnlyPrefix(prefix: string): boolean {
  return READ_ONLY_PREFIXES.some((item) => prefix === item || prefix.startsWith(`${item} `))
}

function isDangerousShellSegment(segment: string): boolean {
  const normalized = normalizeWhitespace(segment)
  if (!normalized) return false

  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true
  }

  return readsSecretAndSendsNetwork(segment)
}

function readsSecretAndSendsNetwork(value: string): boolean {
  const readsSecret = /\b(cat|type|get-content|gc)\b[\s\S]*(\.env|id_rsa|id_ed25519|\.pem|\.key)/i.test(value)
  const sendsNetwork = /\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|nc|netcat)\b/i.test(value)
  return readsSecret && sendsNetwork
}

function commandPrefix(command: string): string {
  const tokens = tokenizeCommand(command)
  if (tokens.length === 0) return normalizeWhitespace(command)

  const executable = normalizeExecutable(tokens[0] ?? "")
  const second = tokens[1]?.toLowerCase()
  const third = tokens[2]?.toLowerCase()

  if ((executable === "npm" || executable === "pnpm") && second === "run" && third) {
    return `${executable} run ${third}`
  }

  if (executable === "yarn" && second === "run" && third) {
    return `yarn run ${third}`
  }

  if ((executable === "npm" || executable === "pnpm" || executable === "yarn" || executable === "git") && second) {
    return `${executable} ${second}`
  }

  if ((executable === "node" || executable === "npm" || executable === "pnpm" || executable === "yarn") && second === "--version") {
    return `${executable} --version`
  }

  return executable
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | "\"" | "`" | undefined

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    const previous = command[index - 1]

    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = undefined
      } else {
        current += char
      }
      continue
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char
      continue
    }

    if (/\s/.test(char ?? "")) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += char
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

function normalizeExecutable(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.(cmd|exe|bat|ps1)$/i, "")
    .toLowerCase() ?? value.toLowerCase()
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}
