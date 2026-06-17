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
node dist/src/cli/index.js run "hello"
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

Stored keys are written to `.agent-cli/agent.db`. That directory is ignored by git and should stay local. It is convenient for development, but do not force-add it to a repository.

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

Shell, edit, and network tools are denied by default.

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

The default storage backend is SQLite:

```json
{
  "storage": {
    "kind": "sqlite",
    "dbPath": ".agent-cli/agent.db"
  }
}
```

Use memory storage for disposable runs:

```bash
npm run dev -- run --storage memory "hello"
```

Use JSON file storage:

```bash
npm run dev -- run --storage file --storage-path .agent-cli/sessions.json "hello"
```

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
- `src/core/tools` - tool registry, scheduler, built-in file/edit/shell/network tools
- `src/core/permissions` - deny-by-default permission policy and approvals
- `src/core/security` - secret redaction helpers
- `src/server` - HTTP routes and SSE
- `test` - Vitest coverage and smoke checks
- `docs` - deeper architecture and workflow notes

## Before Publishing

Run a final local check before pushing:

```bash
npm run preflight
rg -n --hidden -i "api[_-]?key|secret|token|password|bearer|authorization|private[_-]?key" .
```

