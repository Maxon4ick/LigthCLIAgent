import path from "node:path"
import { realpath } from "node:fs/promises"

export function resolveInsideCwd(cwd: string, requestedPath: string): string {
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new Error("Invalid path")
  }

  const resolvedCwd = path.resolve(cwd)
  const resolvedPath = path.resolve(resolvedCwd, requestedPath)
  const relative = path.relative(resolvedCwd, resolvedPath)

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedPath
  }

  throw new Error(`Path escapes cwd: ${requestedPath}`)
}

export class ExternalDirectoryError extends Error {
  readonly name = "ExternalDirectoryError"

  constructor(
    readonly requestedPath: string,
    readonly resolvedPath: string,
    readonly realPath: string,
  ) {
    super(`Path resolves outside cwd through a symlink: ${requestedPath}`)
  }
}

export async function resolveRealInsideCwd(cwd: string, requestedPath: string): Promise<string> {
  const resolvedPath = resolveInsideCwd(cwd, requestedPath)
  const [realCwd, realTarget] = await Promise.all([canonicalPath(cwd), realpath(resolvedPath)])

  if (isInsidePath(realCwd, realTarget)) {
    return realTarget
  }

  throw new ExternalDirectoryError(requestedPath, resolvedPath, realTarget)
}

export async function canonicalPath(filePath: string): Promise<string> {
  return realpath(path.resolve(filePath))
}

export function isInsidePath(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function isProtectedPath(cwd: string, filePath: string): boolean {
  return isProtectedResourcePath(path.relative(cwd, filePath))
}

export function isProtectedResourcePath(resource: string): boolean {
  const normalized = normalizeResource(resource)
  if (!normalized) {
    return false
  }

  const segments = normalized.split("/").filter(Boolean)
  if (segments.includes(".git")) {
    return true
  }

  const basename = segments[segments.length - 1] ?? normalized
  if (basename === ".env" || basename.startsWith(".env.")) {
    return true
  }

  if (basename === "id_rsa" || basename === "id_ed25519") {
    return true
  }

  if (basename.endsWith(".pem") || basename.endsWith(".key")) {
    return true
  }

  if (normalized === ".agent-cli/sessions.json" || normalized.endsWith("/.agent-cli/sessions.json")) {
    return true
  }

  if (normalized === ".agent-cli/audit.log" || normalized.endsWith("/.agent-cli/audit.log")) {
    return true
  }

  if (normalized === ".agent-cli/approvals.json" || normalized.endsWith("/.agent-cli/approvals.json")) {
    return true
  }

  if (normalized.includes("/.agent-cli/snapshots/") || normalized.startsWith(".agent-cli/snapshots/")) {
    return true
  }

  return normalized.includes("/.agent-cli/tool-output/") || normalized.startsWith(".agent-cli/tool-output/")
}

export function normalizeResource(resource: string): string {
  return resource
    .replace(/\\/g, "/")
    .replace(/^[a-z]:/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .toLowerCase()
}
