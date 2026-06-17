# Agent CLI Architecture

Agent CLI is a lightweight local coding-agent runtime. It is intentionally small: the core should stay readable, auditable, and easy to embed, while larger integrations live behind optional adapters.

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
- daemon routes, typed SSE events, and OpenAPI metadata.

Optional adapters should own:

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

The default file store uses atomic writes and a short-lived lock file around `sessions.json`. It is still a lightweight store, not a database. If multi-client usage grows, the next step is per-session shards or an append-only event log before considering SQLite.
