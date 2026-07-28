import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfig, mergeConfig } from "../src/core/config/schema.js"
import { loadWorkspaceSkills } from "../src/core/context/skills.js"
import { materializeSystemContext } from "../src/core/context/system-context.js"
import { createRuntime, createSession } from "../src/core/runtime.js"
import { ToolScheduler } from "../src/core/tools/scheduler.js"

describe("complete skill index and prompt budget", () => {
  it("keeps 25 skills discoverable while budgeting only the prompt catalog", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-skills-25-"))
    const skillRoot = path.join(cwd, ".agents", "skills")
    const creationOrder = [17, 3, 24, 0, 9, 12, 6, 21, 2, 15, 7, 23, 1, 18, 4, 20, 5, 13, 8, 22, 10, 19, 11, 16, 14]
    for (const index of creationOrder) {
      const name = `skill-${String(index).padStart(2, "0")}`
      const dir = path.join(skillRoot, name)
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${"description ".repeat(20)}${index}\n---\n# ${name}\nsecret body ${index}\n`,
        "utf8",
      )
    }

    const config = mergeConfig(defaultConfig, {
      storage: { kind: "memory" },
      agent: {
        skillPaths: [".agents/skills"],
        skillPromptMaxChars: 1_900,
      },
    })
    const runtime = createRuntime(config, cwd)
    const session = createSession(runtime)

    const discovered = await loadWorkspaceSkills(cwd, config.agent.skillPaths)
    expect(discovered).toHaveLength(25)
    expect(discovered.map((skill) => skill.name)).toEqual(
      [...discovered.map((skill) => skill.name)].sort(),
    )

    const scheduler = new ToolScheduler({
      registry: runtime.tools,
      permissionPolicy: runtime.approvals,
      eventBus: runtime.events,
      sessionStore: runtime.sessions,
      config,
      maxOutputBytes: 100_000,
      maxCaptureBytes: 100_000,
      auditLogPath: path.join(cwd, ".agent-cli", "audit.log"),
    })
    const context = {
      sessionId: session.id,
      assistantMessageId: "assistant",
      agentId: session.agentId,
      agentMode: "build" as const,
      cwd,
      abortSignal: new AbortController().signal,
    }

    const [listed] = await scheduler.executeBatch(
      [{ id: "list", name: "list_skills", input: {} }],
      context,
    )
    const listOutput = listed?.output as { skills?: Array<{ name: string }> }
    expect(listOutput.skills).toHaveLength(25)

    const [used] = await scheduler.executeBatch(
      [{ id: "use", name: "use_skill", input: { name: "skill-24" } }],
      context,
    )
    expect(used).toMatchObject({ ok: true })
    expect(JSON.stringify(used?.output)).toContain("secret body 24")

    const system = await materializeSystemContext(session, config)
    const catalog = system.text.slice(system.text.indexOf("Skills provide specialised"))
    expect(catalog.length).toBeLessThanOrEqual(config.agent.skillPromptMaxChars)
    expect(catalog).toContain('total="25"')
    expect(catalog).toMatch(/shown fully \d+; shortened \d+; not shown \d+/)
    expect(catalog).toContain("The full list is available through list_skills.")
    expect(catalog).not.toContain("secret body")
    for (const skill of discovered) expect(system.skills).toContainEqual(skill)
  })
})
