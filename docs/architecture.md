# Agent CLI Architecture

Agent CLI is a lightweight local coding-agent runtime. It is intentionally small: the core should stay readable, auditable, and easy to embed, while larger integrations live behind optional adapters.

The stable library entry point is `src/index.ts` (the published package root).
Core contracts do not import the CLI, TUI, or HTTP server. The supported
dependency direction is core contracts → agent loop/permissions/registries →
built-in adapters → CLI/TUI/HTTP.

`createRuntime({ config, cwd, ...dependencies })` is the canonical asynchronous
composition root; the two-argument overload is deprecated compatibility.
Bundle installation remains separate from executable activation.

## P1 Extension Boundary

```text
core contracts
  -> runtime / runner / scheduler / permissions
  -> built-in providers and file/memory storage
  -> adapters/local, adapters/mcp, adapters/sqlite
  -> CLI / TUI / HTTP
```

Core owns `ToolProvider`, `SkillSource`, `AgentHook`/`HookProvider`,
`ProviderAdapter`, `SessionStore`, `PermissionPolicy`, `EventBus`, and context
budget contracts. It does not import local ESM loaders, the MCP SDK, CLI
parsing, TUI, or HTTP. Optional adapters implement core contracts and are
published through explicit package subpaths.

Initialization is atomic from the object-form caller's perspective: schemas
and providers load before resolution, failures dispose initialized providers,
and the returned runtime has idempotent `dispose()`. Runtime instances do not
share registries or hooks.

Tool execution order is lookup, compiled Ajv validation, `beforeTool`,
revalidation, mode policy, per-capability permissions, execution,
bounds/redaction, observational `afterTool`, and persistence. Local and MCP
adapters assign origin-qualified names/provenance; built-in names remain
compatible.

Context budgeting runs after `beforePrompt` and before provider I/O. The
deterministic compactor removes complete old groups, retains the latest user
prompt and unfinished calls, and never separates calls from matching results.
Mandatory context that cannot fit produces `context_limit`.

## Runtime Map

```text
CLI commands
  run / tui / serve / config
    |
    v
Runtime
  config loader -> model registry -> provider adapter
  event bus -> SSE daemon
  approval mediator -> permission policy
  session store -> messages / summaries / snapshots
    |
    v
SessionRunner
  system context -> provider stream -> tool scheduler
    |
    v
Tools
  read/search -> edit pipeline -> shell/diagnostics -> network -> workflow
```

## Design Goals

- Keep the daily local coding loop fast: prompt, inspect, edit, run diagnostics, review diff, revert if needed.
- Keep state transparent: sessions, approvals, snapshots, audit records, and tool output are plain local files.
- Prefer policy-first safety: shell, edit, and network remain deny-by-default unless config or an explicit approval allows them.
- Make integrations thin and optional: providers, future MCP clients, local tools, SDK clients, and IDE bridges should not become required core dependencies.
- Keep tests close to product risks: provider contracts, daemon/SSE behavior, permissions, edit/revert flows, and CLI smoke checks.

## P0 Execution Boundaries

Tool execution uses explicit capabilities rather than deriving authority from
the broad tool `kind`. The scheduler applies the agent-mode ceiling, validates
input against JSON Schema, asks the unified permission policy for every
declared capability, and only then executes. `delegate_task` uses
`agent.delegate`, not `process.execute`, so shell configuration does not grant
or deny delegation accidentally.

The mode ceiling is centralized in the scheduler. `build` follows normal
permissions; `plan` is read/search plus safe plan/session operations; `explore`
is read/search only; `orchestrate` adds delegation but blocks direct edit,
shell, and network operations. Child tools still pass through the same
permission policy and the child's own mode ceiling.

Skill indexing and prompt rendering are separate: the index contains every
valid skill and deterministic diagnostics, while only the prompt catalog is
budgeted.

Bundle shell scripts and executable tools are only detected and copied as
inert resources in P0. They are never run or activated, and bundle installation
does not write `.claude/settings.local.json`.

The agent loop returns `completed`, `cancelled`, `iteration_limit`, or `error`.
`agent.maxIterations` bounds provider turns. An iteration limit sets the
session and run event to error; abort sets them to cancelled. Tool results are
stored before the next provider turn, usage and results accumulate across
turns, and parent abort signals flow into child runs.

SQLite is an optional native adapter under `src/adapters/sqlite`. The storage
registry constructs memory/file adapters directly and reaches SQLite through a
dynamic import only after explicit selection. `better-sqlite3` is an optional
peer, not a production dependency. Root imports, CLI help, file runs, and memory
runs therefore do not evaluate native SQLite code.

HTTP and TUI are adapters under `src/adapters/http` and `src/adapters/tui`.
The CLI command dispatcher uses dynamic imports, and the `serve` wrapper performs
a second dynamic import of the HTTP entry. The TUI separates the controller,
pure slash-command parser, and pure render surface; terminal side effects stay
owned by the controller/input lifecycle.

Production compilation uses `tsconfig.build.json`; test type-checking uses
`tsconfig.test.json` with `noEmit`. The npm package exposes only the root
library entry point and CLI, and its file allowlist excludes source, tests,
local skills, runtime state, and architecture reference trees.

## Non-Goals

- No desktop/web platform in core.
- No plugin marketplace in core.
- No mandatory Docker/Podman sandbox for all users.
- No broad SDK suite unless the daemon API becomes a primary integration surface.
- No large provider dependency graph when small protocol adapters and fixtures are enough.

## Extension Boundary

Core owns:

- config/schema validation;
- provider contract interfaces and built-in provider adapters;
- session/message/run lifecycle;
- permission decisions and approvals;
- built-in tools and the edit/audit/snapshot pipeline;
- public runtime contracts consumed by the HTTP adapter.

Optional adapters should own:

- HTTP routes, typed SSE events, and OpenAPI metadata;
- terminal input, rendering, and clipboard integration;
- native SQLite sessions and compatibility state;
- MCP stdio/http discovery;
- local custom tool module loading;
- IDE/ACP bridges;
- alternate sandbox backends;
- richer SDK clients;
- model discovery for specific hosted providers.

Any optional adapter must be disabled or inert by default, namespace its tools, and route dangerous capabilities through the same permission policy as built-in tools.

## Event Contract

Daemon events are versioned with `version: 1` and ordered by `sequence`. Prompt executions produce `session.run.started` and `session.run.finished`; abort requests produce `session.run.aborted`. Clients should treat `id` and `sequence` as the stable ordering keys for SSE replay.

## Storage Contract

The default file store uses schema-versioned JSON, atomic temporary-file rename,
a short-lived lock, stale-lock recovery, and workspace boundary validation.
Malformed JSON fails clearly and is never replaced with empty state. Runtime
settings and provider keys use separate atomic files (`settings.json` and
`secrets.json`); key listing exposes provider names and timestamps, never values.
The local secret file is permission-restricted but not encrypted.

Memory storage owns no filesystem state. Existing configurations that explicitly
select SQLite continue to use the optional adapter; selection never silently
falls back to file storage and no automatic database migration is attempted.
