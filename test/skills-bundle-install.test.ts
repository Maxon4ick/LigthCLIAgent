import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { installBundle, scanBundle } from "../src/core/context/bundle-install.js"
import { detectBundlePaths, importSkillsBundle, scanBundleSkills } from "../src/core/context/skills-import.js"

describe("skills bundle import", () => {
  it("discovers root skills and copies whole skill directories", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-skills-import-"))
    const skillsDir = path.join(cwd, "bundle", "skills")
    const childDir = path.join(skillsDir, "child")
    const targetDir = path.join(cwd, ".agents", "skills")

    await mkdir(path.join(childDir, "references"), { recursive: true })
    await writeFile(path.join(skillsDir, "SKILL.md"), "---\nname: bundle-root\n---\n\n# Bundle Root\n", "utf8")
    await writeFile(path.join(childDir, "SKILL.md"), "---\nname: child\n---\n\n# Child\n", "utf8")
    await writeFile(path.join(childDir, "references", "note.md"), "reference content\n", "utf8")

    const candidates = await scanBundleSkills(skillsDir, targetDir, cwd)

    expect(candidates.map((c) => c.name)).toEqual(["bundle-root", "child"])
    expect(candidates.find((c) => c.name === "bundle-root")?.rootSkill).toBe(true)

    const results = await importSkillsBundle(skillsDir, targetDir, cwd)

    expect(results.filter((r) => r.status === "imported")).toHaveLength(2)
    await expect(stat(path.join(targetDir, "SKILL.md"))).resolves.toBeTruthy()
    await expect(readFile(path.join(targetDir, "child", "references", "note.md"), "utf8"))
      .resolves.toBe("reference content\n")
  })

  it("syncs missing resources for already imported skills without overwriting SKILL.md", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-skills-resync-"))
    const skillsDir = path.join(cwd, "bundle", "skills")
    const sourceSkillDir = path.join(skillsDir, "existing")
    const targetSkillDir = path.join(cwd, ".agents", "skills", "existing")

    await mkdir(path.join(sourceSkillDir, "references"), { recursive: true })
    await mkdir(targetSkillDir, { recursive: true })
    await writeFile(path.join(sourceSkillDir, "SKILL.md"), "---\nname: existing\n---\n\n# Source\n", "utf8")
    await writeFile(path.join(sourceSkillDir, "references", "note.md"), "missing ref\n", "utf8")
    await writeFile(path.join(targetSkillDir, "SKILL.md"), "---\nname: existing\n---\n\n# User copy\n", "utf8")

    const results = await importSkillsBundle(skillsDir, path.join(cwd, ".agents", "skills"), cwd)

    expect(results).toEqual([
      { name: "existing", status: "skipped", targetPath: path.join(".agents", "skills", "existing", "SKILL.md") },
    ])
    await expect(readFile(path.join(targetSkillDir, "SKILL.md"), "utf8"))
      .resolves.toContain("# User copy")
    await expect(readFile(path.join(targetSkillDir, "references", "note.md"), "utf8"))
      .resolves.toBe("missing ref\n")
  })

  it("auto-detects a bundle whose skills directory only has a root SKILL.md", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-skills-detect-"))
    const skillsDir = path.join(cwd, "root-only", "skills")

    await mkdir(skillsDir, { recursive: true })
    await writeFile(path.join(skillsDir, "SKILL.md"), "---\nname: root-only\n---\n\n# Root Only\n", "utf8")

    await expect(detectBundlePaths(cwd)).resolves.toEqual([path.join("root-only", "skills")])
  })

  it("copies bundle resources but reports hooks and tools as inactive", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-bundle-install-"))
    const bundleRoot = path.join(cwd, "toolkit")
    const targetDir = path.join(cwd, ".agents", "skills")

    await mkdir(path.join(bundleRoot, "skills", "example", "references"), { recursive: true })
    await mkdir(path.join(bundleRoot, "runtime-hooks"), { recursive: true })
    await mkdir(path.join(bundleRoot, "shared"), { recursive: true })
    await mkdir(path.join(bundleRoot, "tools"), { recursive: true })

    await writeFile(path.join(bundleRoot, "bundle.json"), JSON.stringify({
      name: "Toolkit Bundle",
      skills: "skills",
      hooks: "runtime-hooks",
      shared: "shared",
      tools: "tools",
    }), "utf8")
    await writeFile(path.join(bundleRoot, "skills", "example", "SKILL.md"), "---\nname: example\n---\n\n# Example\n", "utf8")
    await writeFile(path.join(bundleRoot, "skills", "example", "references", "note.md"), "bundled ref\n", "utf8")
    await writeFile(path.join(bundleRoot, "runtime-hooks", "scope.sh"), "# scope.sh - PreToolUse hook for Edit|Write.\n", "utf8")
    await writeFile(path.join(bundleRoot, "runtime-hooks", "opaque.txt"), "inactive hook resource\n", "utf8")
    await writeFile(path.join(bundleRoot, "shared", "rule.md"), "shared rule\n", "utf8")
    await writeFile(path.join(bundleRoot, "tools", "check.py"), "print('ok')\n", "utf8")
    await mkdir(path.join(cwd, ".claude"), { recursive: true })
    const settingsPath = path.join(cwd, ".claude", "settings.local.json")
    const originalSettings = "{\n  \"hooks\": {\"UserHook\": [\"keep\"]}\n}\n"
    await writeFile(settingsPath, originalSettings, "utf8")

    const contents = await scanBundle(bundleRoot, targetDir, cwd)

    expect(contents.componentTargets.map((c) => c.name)).toEqual(["skills", "hooks", "shared", "tools"])
    expect(contents.hookScripts.map((h) => h.matcher)).toEqual(["Edit|Write"])

    const result = await installBundle(bundleRoot, targetDir, cwd)

    expect(result.componentsCopied).toEqual(["skills", "hooks", "shared", "tools"])
    expect(result).toMatchObject({
      hooksDetected: 2,
      executableToolsDetected: 1,
      inactiveComponents: ["hooks", "tools"],
      bundleResourcesCopied: true,
    })
    expect(result.bundleRootPath).toBe(path.join(".agents", "bundles", "toolkit-bundle"))
    await expect(readFile(path.join(cwd, ".agents", "bundles", "toolkit-bundle", "shared", "rule.md"), "utf8"))
      .resolves.toBe("shared rule\n")
    await expect(readFile(path.join(targetDir, "example", "references", "note.md"), "utf8"))
      .resolves.toBe("bundled ref\n")

    await expect(readFile(settingsPath, "utf8")).resolves.toBe(originalSettings)

    const registry = JSON.parse(await readFile(path.join(cwd, ".agents", "bundles.json"), "utf8")) as Array<{
      rootRel: string
      sourceRootRel?: string
      componentsCopied?: string[]
      hooksDetected: number
      executableToolsDetected: number
      inactiveComponents: string[]
    }>
    expect(registry[0]?.rootRel).toBe(path.join(".agents", "bundles", "toolkit-bundle"))
    expect(registry[0]?.sourceRootRel).toBe("toolkit")
    expect(registry[0]?.componentsCopied).toEqual(["skills", "hooks", "shared", "tools"])
    expect(registry[0]).toMatchObject({
      hooksDetected: 2,
      executableToolsDetected: 1,
      inactiveComponents: ["hooks", "tools"],
    })
  })

  it("supports dry-run and repeated installs without overwriting an existing SKILL.md", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-bundle-idempotent-"))
    const bundleRoot = path.join(cwd, "bundle")
    const sourceSkill = path.join(bundleRoot, "skills", "example")
    const targetDir = path.join(cwd, ".agents", "skills")
    const targetSkill = path.join(targetDir, "example", "SKILL.md")
    await mkdir(sourceSkill, { recursive: true })
    await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: example\n---\n# Source\n", "utf8")

    const dryRun = await installBundle(bundleRoot, targetDir, cwd, { dryRun: true })
    expect(dryRun.dryRun).toBe(true)
    await expect(stat(path.join(cwd, ".agents"))).rejects.toMatchObject({ code: "ENOENT" })

    await installBundle(bundleRoot, targetDir, cwd)
    await writeFile(targetSkill, "---\nname: example\n---\n# User version\n", "utf8")
    await installBundle(bundleRoot, targetDir, cwd)
    await expect(readFile(targetSkill, "utf8")).resolves.toContain("# User version")
  })

  it("rejects malformed metadata and registry JSON without replacing existing state", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-bundle-malformed-"))
    const bundleRoot = path.join(cwd, "bundle")
    const targetDir = path.join(cwd, ".agents", "skills")
    await mkdir(path.join(bundleRoot, "skills", "example"), { recursive: true })
    await writeFile(path.join(bundleRoot, "skills", "example", "SKILL.md"), "# Example\n", "utf8")
    await writeFile(path.join(bundleRoot, "bundle.json"), "{broken", "utf8")
    await expect(installBundle(bundleRoot, targetDir, cwd)).rejects.toThrow("Invalid JSON")
    await expect(stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" })

    await writeFile(path.join(bundleRoot, "bundle.json"), "{}", "utf8")
    await mkdir(path.join(cwd, ".agents"), { recursive: true })
    const registryPath = path.join(cwd, ".agents", "bundles.json")
    await writeFile(registryPath, "{broken registry", "utf8")
    await expect(installBundle(bundleRoot, targetDir, cwd)).rejects.toThrow("Invalid JSON")
    await expect(readFile(registryPath, "utf8")).resolves.toBe("{broken registry")
    await expect(stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects bundle symlinks instead of reading or copying outside the bundle", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-bundle-symlink-"))
    const bundleRoot = path.join(cwd, "bundle")
    const outside = path.join(cwd, "outside")
    await mkdir(path.join(bundleRoot, "skills", "safe"), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(bundleRoot, "skills", "safe", "SKILL.md"), "# Safe\n", "utf8")
    await writeFile(path.join(outside, "secret.txt"), "do not copy", "utf8")
    await symlink(outside, path.join(bundleRoot, "shared"), "junction")

    await expect(
      installBundle(bundleRoot, path.join(cwd, ".agents", "skills"), cwd),
    ).rejects.toThrow("resolves outside bundle root")
  })
})
