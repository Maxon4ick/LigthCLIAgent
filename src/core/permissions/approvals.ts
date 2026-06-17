import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createId } from "../../shared/ids.js"
import type { EventBus } from "../events/event-bus.js"
import {
  createRememberedApprovalRule,
  type PermissionDecision,
  type PermissionPolicy,
  type PermissionRequest,
  type PermissionRule,
  type PermissionRuleProvider,
} from "./policy.js"

export interface ApprovalRecord {
  id: string
  request: PermissionRequest
  decision: Exclude<PermissionDecision, "ask">
  remember: boolean
  createdAt: string
  resolvedAt: string
}

export type PendingApprovalStatus = "pending" | "resolved"

export interface PendingApproval {
  id: string
  request: PermissionRequest
  status: PendingApprovalStatus
  createdAt: string
  expiresAt: string
  decision?: Exclude<PermissionDecision, "ask">
  remember?: boolean
  resolvedAt?: string
}

export type ApprovalResponseDecision = Exclude<PermissionDecision, "ask"> | "once" | "always" | "reject"

interface ApprovalWaiter {
  resolve(decision: Exclude<PermissionDecision, "ask">): void
  timeout: NodeJS.Timeout
}

export class InMemoryApprovalStore {
  private readonly records: ApprovalRecord[] = []

  add(
    id: string,
    request: PermissionRequest,
    decision: Exclude<PermissionDecision, "ask">,
    remember: boolean,
  ): ApprovalRecord {
    const record: ApprovalRecord = {
      id,
      request,
      decision,
      remember,
      createdAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
    }

    this.records.push(record)
    return record
  }

  list(): ApprovalRecord[] {
    return [...this.records]
  }
}

export interface RememberedApprovalRuleStore extends PermissionRuleProvider {
  addRule(rule: PermissionRule): void
}

export class InMemoryRememberedApprovalRuleStore implements RememberedApprovalRuleStore {
  private readonly rules: PermissionRule[] = []

  listRules(): PermissionRule[] {
    return [...this.rules]
  }

  addRule(rule: PermissionRule): void {
    if (this.rules.some((item) => sameRule(item, rule))) {
      return
    }

    this.rules.push(rule)
  }
}

interface RememberedApprovalRulesFile {
  version: 1
  rules: PermissionRule[]
}

export class FileRememberedApprovalRuleStore implements RememberedApprovalRuleStore {
  private data: RememberedApprovalRulesFile

  constructor(private readonly filePath: string) {
    this.data = loadRulesFile(filePath)
  }

  listRules(): PermissionRule[] {
    return [...this.data.rules]
  }

  addRule(rule: PermissionRule): void {
    if (this.data.rules.some((item) => sameRule(item, rule))) {
      return
    }

    this.data.rules.push(rule)
    this.persist()
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8")
    renameSync(tmpPath, this.filePath)
  }
}

export interface ApprovalMediatorOptions {
  basePolicy: PermissionPolicy
  eventBus: EventBus
  timeoutMs: number
  rememberedApprovals?: RememberedApprovalRuleStore
}

export class ApprovalMediator implements PermissionPolicy {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly waiters = new Map<string, ApprovalWaiter>()
  private readonly records = new InMemoryApprovalStore()

  constructor(private readonly options: ApprovalMediatorOptions) {}

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const decision = await this.options.basePolicy.decide(request)
    if (decision !== "ask") {
      return decision
    }

    return this.ask(request)
  }

  listPending(sessionId?: string): PendingApproval[] {
    return [...this.pending.values()].filter((approval) => {
      return approval.status === "pending" && (sessionId === undefined || approval.request.sessionId === sessionId)
    })
  }

  listRecords(): ApprovalRecord[] {
    return this.records.list()
  }

  respond(id: string, responseDecision: ApprovalResponseDecision): PendingApproval {
    const approval = this.pending.get(id)
    if (!approval || approval.status !== "pending") {
      throw new Error(`Pending approval ${id} not found`)
    }

    const response = normalizeApprovalResponse(responseDecision)
    const waiter = this.waiters.get(id)
    if (waiter) {
      clearTimeout(waiter.timeout)
    }

    return this.resolveApproval(approval, response.decision, response.remember, true)
  }

  denyPendingForSession(sessionId: string): PendingApproval[] {
    const approvals = this.listPending(sessionId)
    return approvals.map((approval) => this.resolveApproval(approval, "deny", false, true))
  }

  private ask(request: PermissionRequest): Promise<Exclude<PermissionDecision, "ask">> {
    const now = Date.now()
    const id = createId("perm")
    const approval: PendingApproval = {
      id,
      request,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.options.timeoutMs).toISOString(),
    }

    this.pending.set(id, approval)
    this.options.eventBus.publish({
      type: "permission.requested",
      payload: { sessionId: request.sessionId, approval },
    })

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id)
        const current = this.pending.get(id)
        if (current?.status === "pending") {
          const resolved = this.resolveApproval(current, "deny", false, false)
          resolve(resolved.decision ?? "deny")
        } else {
          resolve("deny")
        }
      }, this.options.timeoutMs)

      this.waiters.set(id, { resolve, timeout })
    })
  }

  private resolveApproval(
    approval: PendingApproval,
    decision: Exclude<PermissionDecision, "ask">,
    remember: boolean,
    notifyWaiter: boolean,
  ): PendingApproval {
    if (decision === "allow" && remember) {
      const rule = createRememberedApprovalRule(approval.request)
      if (rule) {
        this.options.rememberedApprovals?.addRule(rule)
      }
    }

    const resolved: PendingApproval = {
      ...approval,
      status: "resolved",
      decision,
      remember,
      resolvedAt: new Date().toISOString(),
    }

    this.pending.set(approval.id, resolved)
    this.records.add(approval.id, approval.request, decision, remember)
    this.options.eventBus.publish({
      type: "permission.resolved",
      payload: {
        sessionId: approval.request.sessionId,
        approval: resolved,
      },
    })

    if (notifyWaiter) {
      const waiter = this.waiters.get(approval.id)
      if (waiter) {
        clearTimeout(waiter.timeout)
        this.waiters.delete(approval.id)
        waiter.resolve(decision)
      }
    }

    return resolved
  }
}

export function resolveApprovalRulesPath(cwd: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(cwd, configuredPath)
}

function normalizeApprovalResponse(response: ApprovalResponseDecision): {
  decision: Exclude<PermissionDecision, "ask">
  remember: boolean
} {
  if (response === "always") {
    return { decision: "allow", remember: true }
  }

  if (response === "once" || response === "allow") {
    return { decision: "allow", remember: false }
  }

  if (response === "deny" || response === "reject") {
    return { decision: "deny", remember: false }
  }

  return { decision: "deny", remember: false }
}

function sameRule(left: PermissionRule, right: PermissionRule): boolean {
  return (
    left.action === right.action &&
    left.resource === right.resource &&
    left.effect === right.effect &&
    left.agentId === right.agentId
  )
}

function loadRulesFile(filePath: string): RememberedApprovalRulesFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown
    if (isRulesFile(parsed)) {
      return parsed
    }
    return { version: 1, rules: [] }
  } catch (error) {
    if (isMissingFileError(error)) {
      return { version: 1, rules: [] }
    }

    throw error
  }
}

function isRulesFile(value: unknown): value is RememberedApprovalRulesFile {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { rules?: unknown }).rules)
  )
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  )
}
