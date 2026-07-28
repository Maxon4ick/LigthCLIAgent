export type RunStopReason =
  | "completed"
  | "cancelled"
  | "iteration_limit"
  | "context_limit"
  | "provider_error"
  | "hook_rejected"
  | "error"

export interface RunStop {
  reason: RunStopReason
  message?: string
  iteration: number
  retryable?: boolean
  errorCode?: string
}
