# Skills Integration Guide

Skills are markdown files that package specialised instructions and workflows into
reusable bundles. The agent discovers them automatically, lists them in the system
prompt, and can load any skill on demand with the `use_skill` tool.

---

## How skills work end-to-end

```
workspace/
  .agents/skills/
    bugfix/
      SKILL.md   ← discovered at startup
    refactor/
      SKILL.md
```

1. **Discovery** — at session start, `loadWorkspaceSkills` walks every path in
   `agent.skillPaths` and collects `SKILL.md` files.
2. **System prompt** — skill names, descriptions, and paths appear in an
   `<available_skills>` XML block sent to the model with every request.
3. **Tool call** — when a task matches a skill, the model calls `use_skill` with the
   skill name. The full file body is returned as the tool result.
4. **Execution** — the model follows the skill's instructions for the current task.

---

## SKILL.md file format

### Recommended: YAML frontmatter

```markdown
---
name: bugfix
description: Systematic approach to diagnosing and fixing bugs in this codebase
---

# Bug Fix Workflow

## Steps

1. Reproduce the bug — write a failing test first.
2. Identify the root cause using `grep` and `read_file`.
3. Make the minimal change that fixes the root cause.
4. Confirm the test passes.
5. Check for related callers that might be affected.

## Rules

- Never suppress errors to make a test pass.
- Prefer fixing the source over adding guards at call sites.
```

The parser reads `name:` and `description:` from the frontmatter block. The rest
of the file is the skill body returned by `use_skill`.

### Fallback: heading + first paragraph

If there is no frontmatter, the parser extracts the name from the first `# Heading`
and the description from the first non-heading, non-empty line:

```markdown
# Performance Profiling

Workflow for profiling and optimising slow code paths.

## Step 1 — measure first
...
```

Both formats work. Frontmatter is preferred for clarity and compatibility with the
opencode / qwen-code skill catalogs.

---

## Directory structure

Skills live inside directories under the configured `skillPaths`. Each skill is a
directory containing a `SKILL.md` file:

```
.agents/
  skills/
    SKILL.md            ← optional root-level skill for the whole bundle
    bugfix/
      SKILL.md          ← individual skill: name "bugfix"
    refactor/
      SKILL.md          ← individual skill: name "refactor"
    release-checklist/
      SKILL.md
```

The `name` field (from frontmatter or `# heading`) is what the model uses when
calling `use_skill`. Keep names short and lowercase — the tool match is
case-insensitive.

---

## Configuration

### Default skill paths

The agent looks in these directories relative to the session `cwd`:

```json
".agents/skills"
".qwen/skills"
".codex/skills"
```

All three are checked in order. You can add your own paths in
`agent-cli.config.json`:

```json
{
  "agent": {
    "skillPaths": [
      ".agents/skills",
      ".qwen/skills",
      ".my-team/skills"
    ]
  }
}
```

Paths are resolved relative to `cwd`. A missing directory is silently skipped —
no error is thrown.

### Limits

- Maximum **20 skills** total (across all paths). Skills found first win.
- Body preview sent to `use_skill` is capped at **4 000 characters**. Long skills
  still work — `use_skill` reads the raw file; only the in-memory preview is
  truncated.

---

## How skills appear in the system prompt

When at least one skill is found, the system prompt includes:

```
Skills provide specialised instructions and workflows for specific tasks.
Use the use_skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>bugfix</name>
    <description>Systematic approach to diagnosing and fixing bugs in this codebase</description>
    <path>.agents/skills/bugfix/SKILL.md</path>
  </skill>
  <skill>
    <name>refactor</name>
    <description>Safe, incremental refactoring patterns</description>
    <path>.agents/skills/refactor/SKILL.md</path>
  </skill>
</available_skills>
```

The model sees this on every turn and decides autonomously when to call `use_skill`.

---

## Built-in tools

### `list_skills`

Returns all discovered skills. No input required.

```json
{
  "skills": [
    { "name": "bugfix", "path": ".agents/skills/bugfix/SKILL.md", "description": "..." },
    { "name": "refactor", "path": ".agents/skills/refactor/SKILL.md", "description": "..." }
  ]
}
```

Useful when you want to ask the agent: *"what skills are available?"*

### `use_skill`

Loads the full body of one skill by name or path.

Input:

```json
{ "name": "bugfix" }
```

Returns the raw markdown content of the matching `SKILL.md`. The match is
case-insensitive and checks both the `name` field and the file path.

---

## Creating a custom skill bundle

### 1 — Create the directory

```
mkdir -p .agents/skills/my-workflow
```

### 2 — Write the SKILL.md

```markdown
---
name: my-workflow
description: Steps for running the internal deployment checklist
---

# My Workflow

## Pre-deploy

- Run `npm test` and confirm all tests pass.
- Check the changelog for the correct version bump.
- Verify no `.env` changes are left uncommitted.

## Deploy

1. Merge to `main`.
2. Tag the release: `git tag v<version>`.
3. Push the tag: `git push origin v<version>`.

## Post-deploy

- Open the Grafana dashboard and watch error rate for 10 minutes.
- Post a deploy note in the team Slack channel.
```

### 3 — Verify discovery

Start a session in the workspace directory and ask:

```
what skills do you have?
```

The agent will call `list_skills` and report your new skill.

### 4 — Use it

```
follow the my-workflow skill to deploy the current release
```

The agent will call `use_skill { "name": "my-workflow" }` and execute accordingly.

---

## Tips for writing effective skills

**Be prescriptive, not descriptive.**
List steps the agent should execute, not background information about the domain.

**Keep the description to one sentence.**
The description appears in the system prompt on every turn. The body is only loaded
on demand, so keep the full instructions in the body.

**Use markdown structure.**
Numbered lists for sequential steps, bullet lists for rules or options. The model
reads the body as-is, so clear structure improves reliability.

**Name skills for the task, not the technology.**
`bugfix` is better than `typescript-error-handling`. The model matches the name
against the user's request, so natural task names work best.

**Combine with AGENTS.md for project rules.**
Put project-wide conventions in `AGENTS.md` (always included) and task-specific
workflows in skills (loaded on demand).

---

## Experimenting with skill bundles

Because `skillPaths` is just a list of directories, you can maintain multiple
separate bundles and swap them in `agent-cli.config.json`:

```json
{
  "agent": {
    "skillPaths": [
      ".agents/skills/core",
      ".agents/skills/experiments/bundle-a"
    ]
  }
}
```

Or point a path at a shared location outside the project:

```json
{
  "agent": {
    "skillPaths": [
      ".agents/skills",
      "C:/shared-skills/team-workflows"
    ]
  }
}
```

Skills from earlier paths take priority when names collide, so `core` skills
shadow `experiments` skills of the same name.

---

## Reference implementations

Both `opencode/` and `qwen-code/` in this repo contain example skill files you can
study and adapt:

| Location | Name | What it covers |
|---|---|---|
| `opencode/packages/core/skills/effect/SKILL.md` | `effect` | Working with Effect v4 TypeScript |
| `qwen-code/docs/skills/bugfix/SKILL.md` | `bugfix` | Bug diagnosis and fixing workflow |

These use the same frontmatter format and are compatible with this wrapper.
