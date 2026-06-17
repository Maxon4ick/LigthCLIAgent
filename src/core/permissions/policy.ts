import { isProtectedResourcePath } from "../tools/builtins/path-utils.js"
import { isDangerousShellCommand } from "./shell-command.js"

export type PermissionDecision = "allow" | "deny" | "ask"
export type PermissionAction = "read" | "search" | "execute" | "edit" | "network" | "external_directory"
export type PermissionRuleEffect = PermissionDecision

export interface PermissionRequest {
  sessionId: string
  agentId: string
  action: PermissionAction
  resources: string[]
  source: {
    type: "tool"
    toolCallId: string
    messageId?: string
  }
}

export interface PermissionPolicy {
  decide(request: PermissionRequest): Promise<PermissionDecision>
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
    const matchingRules = this.matchingRules(request)
    if (matchingRules.some((rule) => rule.effect === "deny")) {
      return "deny"
    }

    if (request.action === "execute" && request.resources.some(isDangerousCommand)) {
      return "ask"
    }

    if (this.allResourcesHaveEffect(request, "allow")) {
      return "allow"
    }

    if (matchingRules.some((rule) => rule.effect === "ask")) {
      return "ask"
    }

    if (request.action === "external_directory") {
      return "ask"
    }

    if (request.action === "read" || request.action === "search") {
      if (request.resources.some(isProtectedResourcePath)) {
        return "ask"
      }

      return "allow"
    }

    if (request.action === "execute") {
      if (this.options.allowShell) return "allow"
      return this.options.askForShell ? "ask" : "deny"
    }

    if (request.action === "edit") {
      if (this.options.allowEdit) return "allow"
      return this.options.askForEdit ? "ask" : "deny"
    }

    if (request.action === "network") {
      if (this.options.allowNetwork) return "allow"
      return this.options.askForNetwork ? "ask" : "deny"
    }

    return "deny"
  }

  private matchingRules(request: PermissionRequest): PermissionRule[] {
    const rules = [...(this.options.rules ?? []), ...(this.options.rememberedRules?.listRules() ?? [])]
    return rules.filter((rule) => {
      if (rule.action !== "*" && rule.action !== request.action) {
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
      if (rule.action !== "*" && rule.action !== request.action) {
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
  if (request.resources.length === 0 || request.action === "external_directory") {
    return undefined
  }

  if (
    (request.action === "execute" && request.resources.some(isDangerousCommand)) ||
    request.action === "network"
  ) {
    return undefined
  }

  if (request.action === "execute" && request.resources.length > 1) {
    return undefined
  }

  const resource = request.resources[0]
  if (!resource) {
    return undefined
  }

  return {
    action: request.action,
    resource,
    effect: "allow",
    agentId: request.agentId,
    source: "remembered",
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
