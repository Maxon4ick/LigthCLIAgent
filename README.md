# Agent CLI Scaffold

A small local runtime for building coding-agent workflows. It includes a CLI, terminal UI, HTTP daemon, provider adapters, session storage, tool execution, and a conservative permission layer for shell, edit, and network actions.

The default provider is `mock`, so the project runs immediately after install without an API key.

## Requirements

- Node.js 22 or newer
- npm

Check your local versions:

```bash
node --version
npm --version
```

## Install

Clone the repository, install dependencies, and run the full verification suite:

```bash
git clone <repo-url>
cd agentsCli
npm ci
npm run preflight
```

`npm run preflight` runs build, typecheck, tests, and the smoke test.

For an installed package, the minimal flow uses JSON storage and does not
install native SQLite:

```bash
npm install agent-cli-scaffold
agent-cli run --storage file "hello"
```

The package name and `UNLICENSED` status are placeholders that must be resolved
by the owner before any public publish.

## Run From Source

Run a prompt with the built-in mock provider:

```bash
npm run dev -- run "hello"
```

Print JSON output:

```bash
npm run dev -- run --json "hello"
```

Start the terminal UI:

```bash
npm run dev -- tui
```

Start the local HTTP daemon:

```bash
npm run dev -- serve --host 127.0.0.1 --port 4170
```

## Build And Link

Build the TypeScript output:

```bash
npm run build
```

Run the compiled CLI directly:

```bash
node dist/cli/index.js run "hello"
```

Expose the `agent-cli` binary globally from this checkout:

```bash
npm link
agent-cli run "hello"
```

## Providers And API Keys

The mock provider needs no key:

```bash
npm run dev -- run --provider mock --model mock-agent "hello"
```

For OpenAI-compatible endpoints, prefer environment variables or the local key store. Avoid committing raw `apiKey` values into `agent-cli.config.json`.

PowerShell:

```powershell
$env:OPENAI_API_KEY = "<your-api-key>"
npm run dev -- run --provider openai-compatible --model gpt-4.1-mini "hello"
```

macOS/Linux:

```bash
export OPENAI_API_KEY="<your-api-key>"
npm run dev -- run --provider openai-compatible --model gpt-4.1-mini "hello"
```

Custom OpenAI-compatible endpoint:

```bash
npm run dev -- run \
  --provider openai-compatible \
  --model qwen2.5-coder \
  --base-url http://127.0.0.1:8000/v1 \
  "hello"
```

Anthropic and Gemini:

```bash
npm run dev -- run --provider anthropic --model claude-sonnet-4-5 "hello"
npm run dev -- run --provider gemini --model gemini-2.5-pro "hello"
```

Supported environment variables:

- `OPENAI_API_KEY`
- `OPENAI_COMPATIBLE_API_KEY`
- `OPENAI_COMPATIBLE_BASE_URL`
- `OPENAI_COMPATIBLE_MODEL`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`

## Local Key Store

You can store provider keys locally:

```bash
npm run dev -- keys set openai-compatible <your-api-key>
npm run dev -- keys list
npm run dev -- keys delete openai-compatible
```

Stored keys are written to `.agent-cli/secrets.json` by default. The file is
permission-restricted on POSIX, ignored by git, and redacted from CLI listings,
but it is not an encrypted vault. Environment variables remain the recommended
way to supply provider keys. An explicitly selected SQLite configuration keeps
using `.agent-cli/agent.db`.

## TUI With A Self-Hosted vLLM Endpoint

vLLM exposes an OpenAI-compatible API, so it works through the
`openai-compatible` provider. The TUI accepts the same provider flags as `run`.

One-off launch with the key in an environment variable:

```bash
export OPENAI_COMPATIBLE_API_KEY="<your-token>"
npm run dev -- tui \
  --provider openai-compatible \
  --model <served-model-name> \
  --base-url https://your-vllm-host:8000/v1
```

Use the exact model name vLLM serves. The base URL may end in `/v1`,
`/v1/models`, or the full `/v1/chat/completions`; the provider normalizes it to
the chat-completions route. The key is sent as `Authorization: Bearer <token>`,
which matches vLLM's `--api-key` option. HTTPS needs no extra configuration.

Persistent setup so that plain `npm run dev -- tui` works:

1. Store the key once in the local key store:

   ```bash
   npm run dev -- keys set openai-compatible <your-token>
   ```

2. Create `agent-cli.config.json` in the workspace with the endpoint and model,
   without the key:

   ```json
   {
     "model": { "provider": "openai-compatible", "model": "<served-model-name>" },
     "providers": {
       "openaiCompatible": {
         "baseUrl": "https://your-vllm-host:8000/v1",
         "apiKeyEnv": "OPENAI_COMPATIBLE_API_KEY"
       }
     }
   }
   ```

3. Run `npm run dev -- tui`.

Key lookup order is `providers.openaiCompatible.apiKey`, then the variable named
by `apiKeyEnv`, then `OPENAI_COMPATIBLE_API_KEY`, then `OPENAI_API_KEY`. Keys
saved with `keys set` are injected into the provider config at startup.
`--api-key <token>` and `--api-key-env <VAR>` are also accepted, but a flag
value lands in shell history, so prefer the environment variable or key store.

Notes:

- If the vLLM host uses a self-signed or private-CA certificate, point Node at
  the CA bundle before launching, otherwise the request fails with a
  certificate error:

  ```bash
  export NODE_EXTRA_CA_CERTS=/path/to/ca.pem
  ```

- The TUI starts in ask mode, so shell, edit, and network tool calls prompt for
  approval. Add `--allow-shell`, `--allow-edit`, or `--allow-network` to
  pre-approve them for the session.

## Common Commands

Run a prompt:

```bash
npm run dev -- run "summarize this project"
```

Use a working directory other than the current shell directory:

```bash
npm run dev -- run --cwd C:\path\to\project "inspect package.json"
```

Continue a persisted session:

```bash
npm run dev -- run --session <session-id> "continue"
```

Use an agent mode:

```bash
npm run dev -- run --mode plan "make an implementation plan"
npm run dev -- run --mode explore "map the codebase"
npm run dev -- run --mode build "implement the change"
npm run dev -- run --mode orchestrate "delegate implementation and summarize"
```

Inspect effective config:

```bash
npm run dev -- config
```

List available models:

```bash
npm run dev -- models list
```

Add a custom model:

```bash
npm run dev -- models add \
  --provider my-local \
  --model llama3 \
  --protocol openai-compatible \
  --no-usage
```

## File Mentions

Prompts can reference local files with `@file` mentions:

```bash
npm run dev -- run "summarize @README.md and @src/core/runtime.ts"
```

Protected paths such as `.env`, private keys, and `.agent-cli` internals are skipped so file mentions do not bypass the permission model.

## Permissions

Shell, edit, and network tools are denied by default. Internally, all tools
pass through one capability policy (`filesystem.read`, `filesystem.write`,
`process.execute`, `network.request`, `agent.delegate`, `session.update`, and
`user.interact`). Agent modes restrict capabilities before configured
permission rules are consulted.

Delegation is independent from shell execution: `delegate_task` uses
`agent.delegate`, so it can run when `allowShell` and `allowEdit` are false.
It can still be denied explicitly:

```json
{
  "permissions": {
    "rules": [
      { "action": "delegate", "resource": "*", "effect": "deny" }
    ]
  }
}
```

Mode ceilings are enforced by the scheduler before a tool can execute:

- `build` uses the ordinary permission policy.
- `plan` permits read/search/skill tools and safe plan/session operations.
- `explore` permits only read/search/skill tools.
- `orchestrate` permits read/search/skill tools plus `delegate_task`; direct
  edit, shell, and network tools are blocked.

For quick local experiments, allow a capability explicitly:

```bash
npm run dev -- run --allow-shell "run shell npm --version"
npm run dev -- run --allow-edit "edit sample.txt"
npm run dev -- run --allow-network "fetch https://example.com"
```

For mediated approvals, use the TUI or daemon ask mode:

```bash
npm run dev -- tui
npm run dev -- serve --ask-permissions --approval-timeout-ms 30000
```

Successful edits are audited under `.agent-cli/` and can be inspected or reverted through the session APIs.

## Storage

The default storage backend is a workspace-relative JSON file:

```json
{
  "storage": {
    "kind": "file",
    "path": ".agent-cli/sessions.json"
  }
}
```

Use memory storage for disposable runs:

```bash
npm run dev -- run --storage memory "hello"
```

Use the default JSON file storage explicitly:

```bash
npm run dev -- run --storage file --storage-path .agent-cli/sessions.json "hello"
```

SQLite is an opt-in native adapter:

```bash
npm install better-sqlite3
agent-cli run --storage sqlite "hello"
```

It is loaded dynamically only for `storage.kind: "sqlite"` or an explicit
`agent-cli-scaffold/sqlite` import. If the peer is absent, the CLI prints an
installation hint without a stack trace. Existing SQLite configurations remain
SQLite configurations; there is no automatic SQLite-to-JSON migration and
`.agent-cli/agent.db` is never deleted or rewritten by the file adapter.

## Embed The Runtime

The package root is the stable library entry point:

```ts
import {
  createRuntime,
  createSession,
  addUserPrompt,
  defaultConfig,
  mergeConfig,
} from "agent-cli-scaffold"

const runtime = await createRuntime({
  config: mergeConfig(defaultConfig, { storage: { kind: "memory" } }),
  cwd: process.cwd(),
  toolProviders: [myToolProvider],
  skillSources: [workspaceSkills],
  hooks: [auditHook],
})

const session = createSession(runtime)
addUserPrompt(runtime, session.id, "Summarize package.json")
const result = await runtime.runner.run(session.id)
console.log(result.stop)
await runtime.dispose()
```

Optional adapters use explicit subpaths and are absent from the root import
graph:

```ts
import { createRuntime } from "agent-cli-scaffold"
import { createHttpAdapter } from "agent-cli-scaffold/http"
import { tuiCommand } from "agent-cli-scaffold/tui"
import { createSqliteAdapter } from "agent-cli-scaffold/sqlite"
```

The canonical object form is asynchronous because providers may initialize
resources. Provider, session store, permission policy, event bus, tool
providers, skill sources, hooks, and context budgeting are injected. The old
`createRuntime(config, cwd)` overload remains for compatibility. Every runtime
owns its registries and hooks, and `runtime.dispose()` is idempotent.

`SessionRunResult.stop.reason` is one of `completed`, `cancelled`,
`iteration_limit`, `context_limit`, `provider_error`, `hook_rejected`, or
`error`. The deprecated `stopReason` alias remains temporarily.

## Extension API

Built-ins use the same `ToolProvider` contract as extensions. Built-in names
remain unqualified; programmatic providers receive a deterministic namespace,
and standard adapters use `local__<provider>__<tool>` or
`mcp__<server>__<tool>`. Registry entries expose `providerId` and provenance.
Tool input schemas are compiled once with Ajv at registration. The scheduler
validates input before hooks or permissions, revalidates a transformed
`beforeTool` input, applies mode and per-capability permissions, executes,
bounds/redacts output, then notifies `afterTool`.

### Trusted local tools

Local ESM tools require a versioned manifest and explicit activation:

```json
{
  "version": 1,
  "id": "team",
  "entry": "./index.js",
  "tools": [{
    "export": "lintTool",
    "name": "lint",
    "description": "Run the configured linter",
    "capabilities": ["process.execute"],
    "inputSchema": {
      "type": "object",
      "properties": { "fix": { "type": "boolean" } },
      "additionalProperties": false
    }
  }]
}
```

Inspection validates metadata without importing the entry:

```bash
agent-cli tools inspect ./extensions/team-tools/agent-tools.json
agent-cli tools list --allow-local-extension ./extensions/team-tools/agent-tools.json
agent-cli run --allow-local-extension ./extensions/team-tools/agent-tools.json "lint"
```

Merely placing a manifest in a workspace or installing a bundle never executes
it. `LocalToolProvider` and `LocalHookProvider` are exported from
`agent-cli-scaffold/adapters/local`.

### Hooks

Hooks run by `priority`, then `id`. `beforePrompt` and `beforeTool` are
fail-closed and may transform or reject input. Transformed tool input is
schema-validated again. `afterTool` is observational and sees bounded/redacted
data; `onStop` runs once. Errors from `afterTool` and `onStop` are reported
without changing the result. Timeouts use `extensions.hookTimeoutMs`.

### Optional MCP

`McpToolProvider` is exported from `agent-cli-scaffold/adapters/mcp`. It is
disabled unless `enabled: true`; P1 supports stdio only. The official
`@modelcontextprotocol/sdk` is an optional peer loaded dynamically only when
the default MCP client is used. Tests and hosts can inject `McpClientLike`.

### Context budget

The deterministic estimator reserves output tokens and includes system
context, skills/summary, messages, and tool schemas. Above the configured
threshold it removes only old completed groups, preserves the latest user turn,
and never separates tool call/result pairs. It emits `context.compacted`; if
mandatory context cannot fit, no provider call occurs and the run stops with
`context_limit`.

### Trust model

- `SKILL.md` is instruction/data loaded through a `SkillSource`.
- Local ESM tools and programmatic hooks are trusted executable Node.js code.
- An MCP server is an explicitly configured external executable/service.
- Installation is not activation.
- Scheduler permissions are not a sandbox for top-level code already executed
  by an imported ESM module.
- Untrusted executable extensions need a future process/container sandbox.

## Skills And Bundles

Skill discovery builds a complete deterministic index. The system prompt uses
a character-budgeted catalog, while `list_skills` and `use_skill` retain access
to every indexed skill. Duplicate names and invalid or unreadable `SKILL.md`
files are returned as diagnostics. `agent.skillPromptMaxChars` controls only
the compact catalog: full `SKILL.md` bodies and `bodyPreview` are never injected
automatically. When entries are shortened or omitted, the prompt reports the
total/full/shortened/omitted counts and points to `list_skills`.

Bundle installation imports skills and their resources, and may copy bundle
metadata/resources under `.agents/bundles`. Executable tools and hooks are
detected but are not activated by installation. Bundle tools use the versioned
local tool manifest and `LocalToolProvider`; bundle hooks use the versioned
hook manifest and `LocalHookProvider`. Both require explicit trust.
Installation never modifies `.claude/settings.local.json`.

```bash
agent-cli skills bundle install ./my-bundle
agent-cli skills bundle install ./my-bundle --dry-run
```

Existing `SKILL.md` files are preserved unless an embedding caller explicitly
requests overwrite.

## Build And Package Boundary

`tsconfig.build.json` compiles production `src/` with declarations;
`tsconfig.test.json` type-checks source plus tests without emitting. `npm run
verify:pack` verifies the `npm pack --dry-run --json` file list, denylist, entry
count, and size budgets. `npm run smoke:tarball` installs the real tarball with
`--omit=optional`; `npm run scan:secrets` scans tracked and packaged files. The published
package contains `dist`, declarations, README, and package metadata—not tests,
source, local `.agents`, runtime state, or reference repositories. The package
is marked `UNLICENSED`; no open-source license is implied. Source maps and
declaration maps are intentionally included for local debugging.

## HTTP Daemon

Start the daemon on loopback:

```bash
npm run dev -- serve --host 127.0.0.1 --port 4170
```

Protect session routes with bearer auth:

```bash
npm run dev -- serve --auth-token "<local-token>"
curl http://127.0.0.1:4170/sessions -H "authorization: Bearer <local-token>"
```

The server refuses non-loopback hosts unless `server.authToken` is configured.

Useful routes:

- `GET /health`
- `GET /capabilities`
- `GET /tools`
- `GET /models`
- `GET /openapi.json`
- `POST /sessions`
- `GET /sessions`
- `POST /sessions/:id/prompt`
- `GET /sessions/:id/events`
- `GET /sessions/:id/permissions`
- `POST /sessions/:id/permissions/:permissionId`
- `POST /sessions/:id/abort`
- `GET /sessions/:id/diff`
- `POST /sessions/:id/revert`

Create a session and send a prompt:

```bash
curl -X POST http://127.0.0.1:4170/sessions
curl -X POST http://127.0.0.1:4170/sessions/<id>/prompt \
  -H "content-type: application/json" \
  -d "{\"prompt\":\"hello\"}"
```

## Configuration

Create `agent-cli.config.json` in the workspace to override defaults. Keep secrets out of this file when it is committed.

Example committed config:

```json
{
  "model": {
    "provider": "openai-compatible",
    "model": "gpt-4.1-mini"
  },
  "providers": {
    "openaiCompatible": {
      "baseUrl": "https://api.openai.com/v1/chat/completions",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  },
  "permissions": {
    "allowShell": false,
    "allowEdit": false,
    "allowNetwork": false
  },
  "agent": {
    "maxIterations": 10,
    "skillPromptMaxChars": 16000,
    "contextBudget": {
      "enabled": true,
      "reserveOutputTokens": 4096,
      "compactionThreshold": 0.85
    }
  },
  "extensions": {
    "hookTimeoutMs": 5000,
    "trustedLocalManifests": [],
    "mcpServers": []
  }
}
```

## Development

```bash
npm run build
npm run typecheck
npm test
npm run smoke
npm run preflight
```

Project layout:

- `src/cli` - command entrypoints for `run`, `tui`, `serve`, `config`, `keys`, and `models`
- `src/core/config` - config schema, defaults, and environment overrides
- `src/core/session` - sessions, messages, storage, snapshots, fork, compact, and runner logic
- `src/core/llm` - provider adapters and model registry
- `src/core/tools` - provider-backed registry, Ajv validation, scheduler, and built-ins
- `src/core/hooks` - deterministic lifecycle hook pipeline
- `src/adapters/local` - trusted local ESM tool and hook manifests
- `src/adapters/mcp` - optional stdio MCP tool provider
- `src/adapters/sqlite` - optional native storage adapter
- `src/adapters/http` - HTTP routes, server lifecycle, and SSE
- `src/adapters/tui` - controller, pure command parser, and render modules
- `src/core/permissions` - deny-by-default permission policy and approvals
- `src/core/security` - secret redaction helpers
- `test` - Vitest coverage and smoke checks
- `docs` - deeper architecture and workflow notes

## Before Publishing

Run a final local check before pushing:

```bash
npm run release:check
```

`release:check` builds from a cleaned `dist`, runs typecheck/tests/CLI smoke,
verifies package contents, installs the tarball without optional dependencies,
scans secrets, and audits production dependencies. It does not publish, tag, or
push anything. The release workflow likewise performs checks only.
