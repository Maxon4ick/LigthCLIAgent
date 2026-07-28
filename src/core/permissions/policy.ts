import { isProtectedResourcePath } from "../tools/builtins/path-utils.js"
import { isDangerousShellCommand } from "./shell-command.js"

export type PermissionDecision = "allow" | "deny" | "ask"
export type Capability =
  | "filesystem.read"
  | "filesystem.write"
  | "process.execute"
  | "network.request"
  | "agent.delegate"
  | "session.update"
  | "user.interact"
  | "external.invoke"
  | "filesystem.external"

/** @deprecated Use Capability. Legacy values remain valid in configuration. */
export type LegacyPermissionAction =
  | "read"
  | "search"
  | "execute"
  | "edit"
  | "network"
  | "delegate"
  | "external_directory"
export type PermissionAction = Capability | LegacyPermissionAction
export type PermissionRuleEffect = PermissionDecision

export interface PermissionRequest {
  sessionId: string
  agentId: string
  action: PermissionAction
  resources: string[]
  requiresApproval?: boolean
  source: {
    type: "tool"
    toolCallId: string
    messageId?: string
  }
}

export interface PermissionPolicy {
  decide(request: PermissionRequest, abortSignal?: AbortSignal): Promise<PermissionDecision>
  denyPendingForSession?(sessionId: string): unknown
}

export interface PermissionRule {
  action: PermissionAction | "*"
  resource: string
  effect: PermissionRuleEffect
  agentId?: string
  source?: "config" | "remembered" | "default"
}

export interface PermissionRuleProvider {
  listRules(): PermissionRule[]
}

export interface DefaultPermissionPolicyOptions {
  allowShell: boolean
  allowEdit: boolean
  askForShell: boolean
  askForEdit: boolean
  allowNetwork?: boolean
  askForNetwork?: boolean
  rules?: PermissionRule[]
  rememberedRules?: PermissionRuleProvider
}

export interface RulesetPermissionPolicyOptions extends DefaultPermissionPolicyOptions {}

export class RulesetPermissionPolicy implements PermissionPolicy {
  constructor(private readonly options: DefaultPermissionPolicyOptions) {}

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    request = { ...request, action: normalizeCapability(request.action) }
    const matchingRules = this.matchingRules(request)
    if (matchingRules.some((rule) => rule.effect === "deny")) {
      return "deny"
    }

    if (request.action === "process.execute" && request.resources.some(isDangerousCommand)) {
      return "ask"
    }

    if (this.allResourcesHaveEffect(request, "allow")) {
      return "allow"
    }

    if (matchingRules.some((rule) => rule.effect === "ask")) {
      return "ask"
    }

    if (request.action === "filesystem.external") {
      return "ask"
    }

    if (request.action === "filesystem.read") {
      if (request.resources.some(isProtectedResourcePath)) {
        return "ask"
      }

      return request.requiresApproval ? "ask" : "allow"
    }

    if (request.action === "process.execute") {
      if (this.options.allowShell) return "allow"
      return this.options.askForShell ? "ask" : "deny"
    }

    if (request.action === "filesystem.write") {
      if (this.options.allowEdit) return "allow"
      return this.options.askForEdit ? "ask" : "deny"
    }

    if (request.action === "network.request") {
      if (this.options.allowNetwork) return "allow"
      return this.options.askForNetwork ? "ask" : "deny"
    }

    if (
      request.action === "agent.delegate" ||
      request.action === "session.update" ||
      request.action === "user.interact"
    ) {
      return request.requiresApproval ? "ask" : "allow"
    }

    return "deny"
  }

  private matchingRules(request: PermissionRequest): PermissionRule[] {
    const rules = [...(this.options.rules ?? []), ...(this.options.rememberedRules?.listRules() ?? [])]
    return rules.filter((rule) => {
      if (rule.action !== "*" && normalizeCapability(rule.action) !== request.action) {
        return false
      }

      if (rule.agentId && rule.agentId !== request.agentId) {
        return false
      }

      return request.resources.some((resource) => resourceMatches(rule.resource, resource))
    })
  }

  private allResourcesHaveEffect(request: PermissionRequest, effect: PermissionRuleEffect): boolean {
    if (request.resources.length === 0) {
      return false
    }

    return request.resources.every((resource) =>
      this.matchingRulesForResource(request, resource).some((rule) => rule.effect === effect),
    )
  }

  private matchingRulesForResource(request: PermissionRequest, resource: string): PermissionRule[] {
    const rules = [...(this.options.rules ?? []), ...(this.options.rememberedRules?.listRules() ?? [])]
    return rules.filter((rule) => {
      if (rule.action !== "*" && normalizeCapability(rule.action) !== request.action) {
        return false
      }

      if (rule.agentId && rule.agentId !== request.agentId) {
        return false
      }

      return resourceMatches(rule.resource, resource)
    })
  }
}

export class DefaultPermissionPolicy extends RulesetPermissionPolicy {}

export function createRememberedApprovalRule(request: PermissionRequest): PermissionRule | undefined {
  const action = normalizeCapability(request.action)
  if (request.resources.length === 0 || action === "filesystem.external") {
    return undefined
  }

  if (
    (action === "process.execute" && request.resources.some(isDangerousCommand)) ||
    action === "network.request"
  ) {
    return undefined
  }

  if (action === "process.execute" && request.resources.length > 1) {
    return undefined
  }

  const resource = request.resources[0]
  if (!resource) {
    return undefined
  }

  return {
    action,
    resource,
    effect: "allow",
    agentId: request.agentId,
    source: "remembered",
  }
}

export function normalizeCapability(action: PermissionAction): Capability {
  switch (action) {
    case "read":
    case "search":
      return "filesystem.read"
    case "edit":
      return "filesystem.write"
    case "execute":
      return "process.execute"
    case "network":
      return "network.request"
    case "delegate":
      return "agent.delegate"
    case "external_directory":
      return "filesystem.external"
    default:
      return action
  }
}

export function isDangerousCommand(command: string): boolean {
  return isDangerousShellCommand(command)
}

function resourceMatches(pattern: string, resource: string): boolean {
  if (pattern === "*") {
    return true
  }

  const normalizedPattern = normalizeForMatch(pattern)
  const normalizedResource = normalizeForMatch(resource)
  const expression = wildcardToRegExp(normalizedPattern)
  return expression.test(normalizedResource)
}

function normalizeForMatch(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase()
}

function wildcardToRegExp(pattern: string): RegExp {
  let source = ""
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    const next = pattern[index + 1]
    if (char === "*" && next === "*") {
      source += ".*"
      index += 1
      continue
    }

    if (char === "*") {
      source += "[^/]*"
      continue
    }

    source += escapeRegExp(char ?? "")
  }

  return new RegExp(`^${source}$`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
}
