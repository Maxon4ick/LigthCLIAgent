# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`agent-cli-scaffold`: a small, embeddable local coding-agent runtime in TypeScript (ESM, Node >= 22). It ships a CLI (`agent-cli`), a terminal UI, an HTTP/SSE daemon, provider adapters, session storage, a tool scheduler, and a deny-by-default permission layer. The default provider is `mock`, so everything runs and tests without an API key. Only runtime dependency is `ajv`; `better-sqlite3` and `@modelcontextprotocol/sdk` are optional peers loaded via dynamic import.

## Commands

```bash
npm run dev -- run "hello"                 # run CLI from source via tsx (no build needed)
npm run dev -- run --json --storage memory "read package.json"
npm run dev -- tui                         # terminal UI
npm run dev -- serve --port 4170           # HTTP daemon (loopback only unless --auth-token)

npm run build                              # clean dist/ then tsc -p tsconfig.build.json
npm run typecheck                          # tsc -p tsconfig.test.json (src + test, noEmit)
npm test                                   # vitest run (all test/**/*.test.ts)
npx vitest run test/session-runner.test.ts # single test file
npx vitest run -t "runs a mock prompt"     # single test by name
npm run smoke                              # test/smoke-cli.mjs against dist/ (requires build first)
npm run preflight                          # build + typecheck + test + smoke + verify:pack (what CI runs)
npm run release:check                      # preflight + smoke:tarball + scan:secrets + npm audit
```

There is no linter configured. CI runs `preflight`, `smoke:tarball`, and `scan:secrets` on ubuntu and windows, so keep paths cross-platform (`path.join`, no hardcoded `/`).

`npm run smoke` and `verify:pack` operate on `dist/`, so run `npm run build` before them if you changed source.

## Architecture

Full notes live in `docs/architecture.md`; the essentials:

**Dependency direction is strict and enforced by package exports.**
`core contracts -> runtime/runner/scheduler/permissions -> built-in providers + file/memory storage -> adapters (local, mcp, sqlite) -> CLI/TUI/HTTP`.
Nothing in `src/core` may import from `src/adapters` or `src/cli`. `src/index.ts` is the stable library root (`agent-cli-scaffold`); adapters are published only under explicit subpaths (`./http`, `./tui`, `./sqlite`, `./adapters/local`, `./adapters/mcp`, plus `./tools`, `./skills`, `./hooks`). `test/lightweight-import.test.ts` guards that the root import graph never pulls in native SQLite, MCP SDK, TUI, or HTTP code. The CLI dispatcher (`src/cli/index.ts`) uses dynamic imports per command for the same reason.

**Composition root: `createRuntime` in `src/core/runtime.ts`.** The canonical form is `await createRuntime({ config, cwd, ...injected deps })`; it resolves the storage adapter, hook providers, tool providers, skill sources, permission policy, event bus, and context budget manager, and disposes everything on failure. The two-argument `createRuntime(config, cwd)` overload is synchronous legacy and cannot use SQLite. Every runtime owns its own registries; `dispose()` is idempotent.

**Agent loop: `SessionRunner` in `src/core/session/session-runner.ts`.** Builds system context (`src/core/context/system-context.ts`, which also walks up for `AGENTS.md` and renders the budgeted skill catalog), runs `beforePrompt` hooks, applies the context budget/compactor, streams from the `ProviderAdapter`, hands tool calls to `ToolScheduler`, persists tool results before the next provider turn, and loops up to `agent.maxIterations`. `SessionRunResult.stop.reason` is one of `completed | cancelled | iteration_limit | context_limit | provider_error | hook_rejected | error` (see `src/core/run-stop.ts`). Child sessions for `delegate_task` recurse through the same runner via a `runChildSession` callback on `ToolContext`, inheriting the parent abort signal.

**Tool execution pipeline: `src/core/tools/scheduler.ts`.** Order is fixed and tested: registry lookup -> compiled Ajv validation -> `beforeTool` hooks -> revalidation of transformed input -> agent-mode ceiling -> per-capability permission check -> execute -> output bounding/redaction -> `afterTool` hooks -> persist. Consecutive tool calls in a batch run in parallel only while each is safe-concurrent (`metadata.safeConcurrent`, defaulting to true only for `kind: "read" | "search"`); the first unsafe call runs alone. Built-ins live in `src/core/tools/builtins/` and are registered through the same `ToolProvider` contract as extensions (`BuiltInToolProvider` in `registry.ts`). Built-in names are unqualified; local and MCP tools get `local__<provider>__<tool>` / `mcp__<server>__<tool>`.

**Permissions are capability-based, not kind-based.** Tools declare `metadata.capabilities` from `filesystem.read`, `filesystem.write`, `process.execute`, `network.request`, `agent.delegate`, `session.update`, `user.interact`. `RulesetPermissionPolicy` (`src/core/permissions/policy.ts`) evaluates each declared capability; `allowShell`/`allowEdit`/`allowNetwork` config flags and `permissions.rules` feed it. Agent mode is a ceiling applied first: `build` = normal policy, `plan` = read/search/skill + plan/session ops, `explore` = read/search/skill only, `orchestrate` = read/search/skill + `delegate_task`, no direct edit/shell/network. `ApprovalMediator` (`approvals.ts`) handles interactive "ask" decisions for the TUI and daemon with remembered rules.

**Storage.** `src/core/storage/registry.ts` constructs `memory` and `file` adapters directly and reaches `sqlite` only through a dynamic import after explicit selection; there is never a silent fallback or auto-migration between backends. File storage is schema-versioned atomic JSON under `.agent-cli/` (`sessions.json`, `settings.json`, `secrets.json`) with locking; malformed JSON must fail loudly, never be replaced with empty state. `RuntimeStateStore.applyOverrides` layers persisted settings (e.g. active model) onto the loaded config.

**Hooks (`src/core/hooks/hooks.ts`).** Run by `priority` then `id`. `beforePrompt` and `beforeTool` are fail-closed and may transform or reject; `afterTool` and `onStop` are observational and their errors never change the result.

**Extensions trust model.** `SKILL.md` files are data loaded through `SkillSource` (discovery index is complete and deterministic; only the system-prompt catalog is character-budgeted by `agent.skillPromptMaxChars`). Local ESM tools/hooks need a versioned manifest plus explicit activation (`--allow-local-extension` or `extensions.trustedLocalManifests`); bundle installation copies them inert and never activates them or touches `.claude/settings.local.json`. MCP is stdio-only and disabled unless `enabled: true`.

**HTTP daemon (`src/adapters/http`).** Refuses non-loopback hosts without `server.authToken`. Events are `version: 1`, ordered by `sequence`, replayed over SSE. **TUI (`src/adapters/tui`)** is split into a controller (owns terminal side effects), a pure slash-command parser, and a pure render module; keep the parser and renderer free of I/O so they stay unit-testable.

## Testing conventions

- Tests build runtimes with `mergeConfig(defaultConfig, { storage: { kind: "memory" } })` and the mock provider; see `test/session-runner.test.ts` for the pattern.
- `MockProvider` (`src/core/llm/mock-provider.ts`) triggers tool calls from prompt text: `"read package.json"` -> `read_file`, `"grep <pattern>"` -> `grep`, `"run shell <cmd>"` -> `shell`, `"edit sample.txt"` -> `apply_patch`; anything else returns `Mock response: received "<prompt>".`, and any history containing a tool message returns `Done.`. The smoke test asserts on these exact strings.
- Inject fakes through `CreateRuntimeOptions` (provider, sessionStore, permissionPolicy, hooks, toolProviders, skillSources) rather than mocking modules. `McpClientLike` can be injected to test the MCP adapter without the SDK.
- Behavioural guarantees above (pipeline order, lightweight imports, storage boundaries, mode ceilings) each have dedicated tests; extend those files rather than adding parallel ones.

## Packaging constraints

`npm pack` must contain only `dist`, `README.md`, `LICENSE`, `package.json`; `scripts/verify-pack.mjs` enforces a denylist (no `src/`, `test/`, `.agents`, `.agent-cli`, `*prompt*`/`*report*` files, DBs) and size budgets. `scripts/scan-secrets.mjs` scans tracked and packaged files. Add new public subpaths to both `package.json#exports` and the `required` list in `verify-pack.mjs`.

## Notes on docs

`docs/implement-orchestrator.md` is the original implementation plan for delegation and `docs/skills.md` predates the unbounded skill index (it still mentions a 20-skill cap and `opencode/`/`qwen-code/` reference checkouts that are gitignored). Prefer `README.md` and `docs/architecture.md` when they disagree.
