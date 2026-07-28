# Orchestrator / Delegation P0 Contract

## Goal

The runtime has a multi-turn agentic loop and a `delegate_task` tool so that one session (the
orchestrator) can spawn child sessions (sub-agents), wait for their results, and
continue reasoning based on what they return.  No new runtime dependencies.

This document records the implemented P0 contract. Delegation has the dedicated
`agent.delegate` permission (`"delegate"` in config rules); it is not shell
execution and does not depend on `allowShell`. The scheduler enforces modes
before execution: plan/explore cannot delegate, orchestrate may delegate but
cannot directly edit, execute shell, or use network tools, and build follows
ordinary permissions. Child sessions use a distinct `agentId` and the same
permission policy, so they never gain shell/edit/network authority implicitly.

---

## Implemented primitives

| Existing primitive | Where | Notes |
|---|---|---|
| `Session.parentSessionId` | `src/core/session/message-types.ts:14` | Already on the type |
| `Session.agentId` | same file | Already on the type |
| `SessionStore.createSession` | `src/core/session/session-store.ts:7` | Accepts `parentSessionId` |
| `ActiveRunManager` | `src/core/runtime.ts:91` | Manages concurrent runs |
| `ToolContext.sessionStore` | `src/core/tools/tool.ts:38` | Available inside every tool |

---

## Changes — in order

### 1. Multi-turn loop in `SessionRunner`  
**File:** `src/core/session/session-runner.ts`

`run()` loops while the provider produces tool calls and is bounded by
`config.agent.maxIterations`.

```
maxIterations = config.agent.maxIterations

run():
  for iter 0..maxIterations:
    stream LLM → collect assistantText + toolCalls
    save assistant message
    if toolCalls.length === 0: break          // final answer, done
    if abortSignal.aborted: break
    execute tool batch via ToolScheduler
    save tool result messages
    if abortSignal.aborted: break
    // loop: tool results are now in the store, next iter re-reads them
  set session status idle / cancelled / error
  return { sessionId, assistantText, toolResults, usage, stopReason }
```

Keep `assistantText` as the text from the **last** LLM turn (the final answer).
Accumulate all `toolResults` across iterations into one flat array for the return
value.

Usage accumulation: sum `inputTokens`/`outputTokens` across all iterations into a
single `TokenUsage` object so callers see total cost.

`stopReason` is `completed`, `cancelled`, `iteration_limit`, or `error`.
Iteration limit is an error session/run outcome, not an ordinary idle
completion. Tool results are persisted before the next provider call.

---

### 2. Add `runChildSession` to `ToolContext`  
**File:** `src/core/tools/tool.ts`

Add one optional field to `ToolContext`:

```typescript
runChildSession?: (
  sessionId: string,
  signal: AbortSignal,
) => Promise<{ assistantText: string; ok: boolean; error?: string }>
```

This is a callback, not a direct import of `SessionRunner`, so there is no
circular module dependency.

---

### 3. Wire `runChildSession` into `ToolScheduler`  
**File:** `src/core/tools/scheduler.ts`

Add to `ToolSchedulerOptions`:

```typescript
runChildSession?: ToolContext["runChildSession"]
```

In `executeOne()`, when building the `toolContext` object (lines 141-150), add:

```typescript
runChildSession: this.options.runChildSession,
```

---

### 4. Wire the callback from `SessionRunner` into `ToolScheduler`  
**File:** `src/core/session/session-runner.ts`

Where `ToolScheduler` is constructed inside `run()`, add:

```typescript
runChildSession: async (sessionId, signal) => {
  const result = await this.run(sessionId, signal)
  return {
    assistantText: result.assistantText,
    ok: result.stopReason === "completed",
    error: result.error ??
      (result.stopReason === "completed" ? undefined : result.stopReason),
  }
},
```

`this.run` calls itself recursively for child sessions.  Each child session has
its own message list, so there is no shared mutable state between parent and child.
The abort signal threads through, so aborting the parent cancels all children.

---

### 5. Create `delegate_task` tool  
**File:** `src/core/tools/builtins/delegate-task.ts` (new file)

```typescript
import { createId } from "../../../shared/ids.js"
import type { ToolDefinition } from "../tool.js"

interface DelegateInput {
  prompt: string
  mode?: "build" | "plan" | "explore"
  model?: string
  provider?: string
  cwd?: string
}

export const delegateTaskTool: ToolDefinition<DelegateInput> = {
  name: "delegate_task",
  description:
    "Spawn a focused sub-agent session to complete one task and return its final answer. " +
    "Use when a sub-problem is large, requires a different mode, or should run in isolation. " +
    "The sub-agent uses the same permission policy as this session.",
  kind: "delegate",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: false,
    requiresApproval: false,
    capabilities: ["agent.delegate"],
    tags: ["orchestration", "agent"],
  },
  inputSchema: {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt:   { type: "string", description: "The task for the sub-agent." },
      mode:     { type: "string", enum: ["build", "plan", "explore"], description: "Agent mode for the sub-session." },
      model:    { type: "string", description: "Model name override for the sub-agent." },
      provider: { type: "string", description: "Provider override for the sub-agent." },
      cwd:      { type: "string", description: "Working directory override. Defaults to current cwd." },
    },
  },

  async execute(input, ctx) {
    if (!ctx.runChildSession) {
      return { ok: false, error: "delegate_task: runChildSession not available in this context" }
    }

    const model = resolveChildModel(input, ctx.config)
    const childSession = ctx.sessionStore.createSession({
      cwd:             resolveRealInsideCwd(ctx.cwd, input.cwd ?? "."),
      model,
      agentId:         createId("agent"),
      mode:            input.mode ?? "build",
      parentSessionId: ctx.sessionId,
    })

    ctx.sessionStore.addMessage({
      sessionId: childSession.id,
      role:      "user",
      parts:     [{ type: "text", text: input.prompt }],
    })

    const result = await ctx.runChildSession(childSession.id, ctx.abortSignal)

    return {
      ok:     result.ok,
      output: result.assistantText || undefined,
      error:  result.error,
    }
  },
}

function resolveChildModel(input: DelegateInput, config: import("../../config/schema.js").AppConfig) {
  if (input.provider && input.model) {
    return { provider: input.provider, model: input.model }
  }
  // fall back to config small model, then current model
  const small = config.models.small
  if (small && small.provider !== "mock") return small
  return config.model
}
```

---

### 6. Register `delegate_task` in the tool registry  
**File:** `src/core/tools/registry.ts`

Add import:
```typescript
import { delegateTaskTool } from "./builtins/delegate-task.js"
```

Add to the tool list inside `createDefaultToolRegistry`:
```typescript
delegateTaskTool,
```

---

### 7. Add `orchestrate` mode to system context  
**File:** `src/core/context/system-context.ts`

In `materializeSystemContext`, add a branch for the new mode:

```typescript
} else if (session.mode === "orchestrate") {
  parts.push(
    "Orchestrate mode: your job is to decompose the user request into focused sub-tasks " +
    "and delegate each one to a sub-agent using the delegate_task tool. " +
    "Collect sub-agent results and synthesize a final answer. " +
    "Only read/search/skill tools and delegate_task are available directly. " +
    "Do not edit files or run shell/network tools directly.",
  )
}
```

Also update the `AgentMode` type in `src/core/config/schema.ts` from:
```typescript
type AgentMode = "build" | "plan" | "explore"
```
to:
```typescript
type AgentMode = "build" | "plan" | "explore" | "orchestrate"
```

---

### 8. Expose `orchestrate` in the CLI  
**File:** `src/cli/commands/run.ts`

Add `--mode orchestrate` to the `--mode` flag description and default handling so
the user can do:

```bash
npm run dev -- run --mode orchestrate "refactor the auth module and add tests"
```

**File:** `src/cli/tui/render.ts`

Add `/mode orchestrate` to `slashCommandHints` and the `TuiCommand` union.

---

## Concurrency notes

- Multiple `delegate_task` calls in the **same tool batch** will be serialized by
  `ToolScheduler.nextExecutionGroup()` because `safeConcurrent: false`.
- If you want parallel sub-agents, set `safeConcurrent: true` and the scheduler
  will run them with `Promise.all`.  Do not do this until you have tested serial
  delegation first.
- Abort propagation: the parent's `AbortSignal` is passed to each child's
  `runChildSession`.  Cancelling the parent session cancels all in-flight children.

---

## Test plan

After implementing:

1. **Multi-turn unit test** — add a test in `test/session-runner.test.ts` using
   `MockProvider` that returns a tool call on turn 1 and plain text on turn 2.
   Assert the runner returns the turn-2 text and both messages are in the store.

2. **Delegate tool unit test** — new file `test/delegate-task-tool.test.ts`.
   Create two sessions, wire a `runChildSession` stub that returns a fixed string,
   call `delegateTaskTool.execute`, assert output equals the stub string.

3. **Integration smoke** — extend `test/smoke-cli.mjs` or add a new smoke script
   that runs:
   ```bash
   node dist/cli/index.js run --mode orchestrate "delegate a task to summarize package.json"
   ```
   and asserts exit code 0.

---

## Files touched summary

| File | Change |
|---|---|
| `src/core/session/session-runner.ts` | Multi-turn `for` loop + pass `runChildSession` to scheduler |
| `src/core/tools/tool.ts` | Add `runChildSession?` to `ToolContext` |
| `src/core/tools/scheduler.ts` | Accept + forward `runChildSession` in options and context |
| `src/core/tools/registry.ts` | Import + register `delegateTaskTool` |
| `src/core/tools/builtins/delegate-task.ts` | New file — the tool |
| `src/core/context/system-context.ts` | Add `orchestrate` mode branch |
| `src/core/config/schema.ts` | Add `"orchestrate"` to `AgentMode` union |
| `src/cli/commands/run.ts` | Allow `--mode orchestrate` |
| `src/cli/tui/render.ts` | Add `/mode orchestrate` slash command |

No new dependencies.  Estimated total new lines: ~200.
