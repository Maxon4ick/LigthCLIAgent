import type { Capability, PermissionPolicy } from "../permissions/policy.js"
import type { EventBus } from "../events/event-bus.js"
import type { AgentMode, AppConfig } from "../config/schema.js"
import type { SessionStore } from "../session/session-store.js"
import type { SkillSource } from "../context/skills.js"

export type ToolKind = "read" | "search" | "execute" | "edit" | "network" | "delegate" | "other"
export type ToolProvenance = "builtin" | "local" | "mcp" | "bundle"

export interface ToolMetadata {
  safeConcurrent: boolean
  mutatesWorkspace: boolean
  requiresApproval: boolean
  capabilities?: Capability[]
  provenance?: ToolProvenance
  providerId?: string
  tags: string[]
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string
  description: string
  inputSchema: unknown
  kind: ToolKind
  metadata?: Partial<ToolMetadata>
  execute(input: Input, context: ToolContext): Promise<ToolResult<Output>>
}

export interface ToolContext {
  sessionId: string
  assistantMessageId: string
  toolCallId: string
  agentId: string
  agentMode: AgentMode
  cwd: string
  abortSignal: AbortSignal
  permissionPolicy: PermissionPolicy
  config: AppConfig
  maxOutputBytes: number
  maxCaptureBytes?: number
  auditLogPath: string
  eventBus: EventBus
  sessionStore: SessionStore
  skillSources?: readonly SkillSource[]
  delegationDepth?: number
  runChildSession?: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<{ assistantText: string; ok: boolean; error?: string }>
}

export interface ToolResult<Output = unknown> {
  ok: boolean
  output?: Output
  error?: string
}

export interface PublicToolDefinition {
  name: string
  description: string
  inputSchema: unknown
  kind: ToolKind
  metadata: ToolMetadata
}

export interface ToolProviderContext {
  cwd: string
  config: AppConfig
  events: EventBus
  permissions: PermissionPolicy
  abortSignal: AbortSignal
}

/**
 * Programmatic extension boundary. Passing a provider to createRuntime is the
 * explicit activation step; installed bundle code is never loaded implicitly.
 */
export interface ToolProvider {
  id: string
  namespace?: string
  provenance?: ToolProvenance
  failureMode?: "fail" | "isolate"
  requiresExplicitCapabilities?: boolean
  load(context: ToolProviderContext): Promise<ToolDefinition[]> | ToolDefinition[]
  dispose?(): Promise<void> | void
}
