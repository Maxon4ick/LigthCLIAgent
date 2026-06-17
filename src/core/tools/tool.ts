import type { PermissionPolicy } from "../permissions/policy.js"
import type { EventBus } from "../events/event-bus.js"
import type { AgentMode, AppConfig } from "../config/schema.js"
import type { SessionStore } from "../session/session-store.js"

export type ToolKind = "read" | "search" | "execute" | "edit" | "network" | "other"

export interface ToolMetadata {
  safeConcurrent: boolean
  mutatesWorkspace: boolean
  requiresApproval: boolean
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
