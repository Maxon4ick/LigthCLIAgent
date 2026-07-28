import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { loadConfig } from "../../core/config/config-loader.js"
import {
  detectBundleRoots,
  installBundle,
  listInstalledBundles,
  scanBundle,
} from "../../core/context/bundle-install.js"
import { loadSkillIndex, loadWorkspaceSkills, workspaceSkillSources } from "../../core/context/skills.js"
import { detectBundlePaths, importSkillsBundle, scanBundleSkills } from "../../core/context/skills-import.js"

export async function skillsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printSkillsHelp()
    return
  }

  if (subcommand === "list") {
    await skillsList()
    return
  }

  if (subcommand === "add") {
    await skillsAdd(rest)
    return
  }

  if (subcommand === "remove") {
    await skillsRemove(rest)
    return
  }

  if (subcommand === "import") {
    await skillsImport(rest)
    return
  }

  if (subcommand === "bundle") {
    await skillsBundle(rest)
    return
  }

  process.stderr.write(`Unknown skills subcommand: ${subcommand}\n\n`)
  printSkillsHelp()
  process.exitCode = 1
}

async function skillsList(): Promise<void> {
  const cwd = process.cwd()
  const config = await loadConfig({ cwd })
  const index = await loadSkillIndex(cwd, workspaceSkillSources(config.agent.skillPaths))
  const skills = index.skills

  if (skills.length === 0) {
    process.stdout.write("No skills found.\n")
  } else {
    process.stdout.write("Available skills:\n")
    for (const skill of skills) {
      const desc = skill.description ? `  ${skill.description}` : ""
      process.stdout.write(`  ${skill.name}${desc}\n    path: ${skill.path}\n`)
    }
  }
  if (index.diagnostics.length > 0) {
    process.stdout.write("\nSkill diagnostics:\n")
    for (const diagnostic of index.diagnostics) {
      process.stdout.write(`  ${diagnostic.code}: ${diagnostic.message} (${diagnostic.path})\n`)
    }
  }
}

async function skillsAdd(args: string[]): Promise<void> {
  let name: string | undefined
  let description: string | undefined
  let skillPath: string | undefined
  let body: string | undefined
  let fromFile: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === "--description" || arg === "-d") {
      description = args[++i]
      continue
    }
    if (arg === "--skill-path") {
      skillPath = args[++i]
      continue
    }
    if (arg === "--body") {
      body = args[++i]
      continue
    }
    if (arg === "--from-file") {
      fromFile = args[++i]
      continue
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown skills add argument: ${arg}`)
    }
    if (!name) {
      name = arg
      continue
    }
    throw new Error(`Unexpected argument: ${arg}`)
  }

  if (!name) {
    throw new Error("skills add requires a skill name as the first argument")
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      `Skill name "${name}" is invalid. Use lowercase alphanumeric characters, hyphens, or underscores (must start with alphanumeric).`
    )
  }

  const cwd = process.cwd()
  const config = await loadConfig({ cwd })

  const targetSkillPath = skillPath ?? config.agent.skillPaths[0]
  if (!targetSkillPath) {
    throw new Error("No skill path configured. Set agent.skillPaths in agent-cli.config.json.")
  }

  const skillDir = path.resolve(cwd, targetSkillPath, name)
  const skillFile = path.join(skillDir, "SKILL.md")

  try {
    await stat(skillFile)
    throw new Error(`Skill "${name}" already exists at ${path.relative(cwd, skillFile)}`)
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }

  let bodyContent: string
  if (fromFile) {
    const raw = await readFile(path.resolve(cwd, fromFile), "utf8")
    // If the source file already has frontmatter, strip it and use only the body.
    if (raw.trimStart().startsWith("---")) {
      const end = raw.indexOf("\n---", 3)
      bodyContent = end !== -1 ? raw.slice(end + 4).trimStart() : raw
      // Inherit description from source frontmatter when not provided on CLI.
      if (!description) {
        const block = end !== -1 ? raw.slice(3, end) : ""
        const descMatch = /^description:\s*(.+)$/m.exec(block)
        if (descMatch) description = descMatch[1].trim().replace(/^["'>-]+\s*/, "")
      }
    } else {
      bodyContent = raw
    }
  } else if (body) {
    bodyContent = body
  } else {
    bodyContent = `# ${name}\n\nDescribe the skill workflow here.\n`
  }

  const descLine = description ? `description: ${description}\n` : ""
  const content = `---\nname: ${name}\n${descLine}---\n\n${bodyContent.trimStart()}`

  await mkdir(skillDir, { recursive: true })
  await writeFile(skillFile, content, "utf8")

  process.stdout.write(`Skill "${name}" created at ${path.relative(cwd, skillFile)}\n`)
}

async function skillsImport(args: string[]): Promise<void> {
  let bundlePath: string | undefined
  let skillPath: string | undefined
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--skill-path") {
      skillPath = args[++i]
      continue
    }
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown skills import argument: ${arg}`)
    }
    if (!bundlePath) {
      bundlePath = arg
      continue
    }
    throw new Error(`Unexpected argument: ${arg}`)
  }

  const cwd = process.cwd()
  const config = await loadConfig({ cwd })

  if (!bundlePath) {
    const detected = await detectBundlePaths(cwd)
    if (detected.length === 0) {
      throw new Error(
        "No bundle path provided and none auto-detected.\n" +
        "Usage: agent-cli skills import <bundle-path>\n" +
        "Example: agent-cli skills import ascend310p-operator-porting/skills"
      )
    }
    bundlePath = detected[0]
    process.stdout.write(`Auto-detected bundle: ${bundlePath}\n`)
  }

  const targetPath = skillPath ?? config.agent.skillPaths[0]
  if (!targetPath) {
    throw new Error("No skill path configured. Set agent.skillPaths in agent-cli.config.json or pass --skill-path.")
  }

  const bundleAbs = path.resolve(cwd, bundlePath)
  const targetAbs = path.resolve(cwd, targetPath)

  const candidates = await scanBundleSkills(bundleAbs, targetAbs, cwd)
  if (candidates.length === 0) {
    throw new Error(`No skills found in "${bundlePath}". Check the path points to a directory containing skill subdirectories.`)
  }

  const newSkills = candidates.filter((c) => !c.exists)
  const existingSkills = candidates.filter((c) => c.exists)

  process.stdout.write(`Bundle:  ${bundlePath}\n`)
  process.stdout.write(`Target:  ${targetPath}\n`)
  process.stdout.write(`Found:   ${candidates.length} skill${candidates.length === 1 ? "" : "s"} (${newSkills.length} new, ${existingSkills.length} already present)\n\n`)

  for (const c of candidates) {
    const marker = c.exists ? "  -" : "  +"
    const desc = c.description ? `  ${c.description.slice(0, 60)}${c.description.length > 60 ? "..." : ""}` : ""
    process.stdout.write(`${marker} ${c.name}${desc}\n`)
  }

  if (dryRun) {
    process.stdout.write(`\n(dry run — no files written)\n`)
    return
  }

  if (newSkills.length === 0) {
    process.stdout.write(`\nAll skills already present — nothing to import.\n`)
    return
  }

  process.stdout.write(`\nImporting ${newSkills.length} skill${newSkills.length === 1 ? "" : "s"}...\n`)

  const results = await importSkillsBundle(bundleAbs, targetAbs, cwd)
  const imported = results.filter((r) => r.status === "imported")
  const errors = results.filter((r) => r.status === "error")

  for (const r of imported) {
    process.stdout.write(`  ok  ${r.name}  →  ${r.targetPath}\n`)
  }
  for (const r of errors) {
    process.stderr.write(`  err ${r.name}: ${r.error}\n`)
  }

  process.stdout.write(`\nDone: ${imported.length} imported`)
  if (existingSkills.length > 0) process.stdout.write(`, ${existingSkills.length} skipped (already present)`)
  if (errors.length > 0) process.stdout.write(`, ${errors.length} error${errors.length === 1 ? "" : "s"}`)
  process.stdout.write(`\n`)

  if (errors.length > 0) process.exitCode = 1
}

async function skillsRemove(args: string[]): Promise<void> {
  const [name] = args
  if (!name) {
    throw new Error("skills remove requires a skill name. Example: agent-cli skills remove my-skill")
  }

  const cwd = process.cwd()
  const config = await loadConfig({ cwd })
  const skills = await loadWorkspaceSkills(cwd, config.agent.skillPaths)

  const skill = skills.find(
    (s) => s.name.toLowerCase() === name.toLowerCase()
  )

  if (!skill) {
    throw new Error(`Skill "${name}" not found in configured skill paths.`)
  }

  const skillFilePath = path.resolve(cwd, skill.path)
  const skillDir = path.dirname(skillFilePath)
  const skillRootName = path.basename(skillDir)

  // If the skill lives in its own subdirectory (not at the root of a skillPath), remove the directory.
  // Otherwise just remove the SKILL.md file.
  const isSubdirSkill = config.agent.skillPaths.some((sp) => {
    const resolved = path.resolve(cwd, sp)
    return path.resolve(cwd, skillDir) !== resolved
  })

  if (isSubdirSkill && skillRootName !== ".") {
    await rm(skillDir, { recursive: true, force: true })
    process.stdout.write(`Skill "${skill.name}" removed (deleted ${path.relative(cwd, skillDir)})\n`)
  } else {
    await rm(skillFilePath, { force: true })
    process.stdout.write(`Skill "${skill.name}" removed (deleted ${skill.path})\n`)
  }
}

async function skillsBundle(args: string[]): Promise<void> {
  const [sub, ...rest] = args

  if (!sub || sub === "install") {
    await bundleInstall(sub === "install" ? rest : args)
    return
  }

  if (sub === "list") {
    await bundleList()
    return
  }

  process.stderr.write(`Unknown skills bundle subcommand: ${sub}\n`)
  process.stderr.write(`Usage: agent-cli skills bundle install [<bundle-path>] [--dry-run]\n`)
  process.stderr.write(`       agent-cli skills bundle list\n`)
  process.exitCode = 1
}

async function bundleInstall(args: string[]): Promise<void> {
  let bundlePath: string | undefined
  let skillPath: string | undefined
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--skill-path") { skillPath = args[++i]; continue }
    if (arg === "--dry-run") { dryRun = true; continue }
    if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`)
    if (!bundlePath) { bundlePath = arg; continue }
    throw new Error(`Unexpected argument: ${arg}`)
  }

  const cwd = process.cwd()
  const config = await loadConfig({ cwd })

  if (!bundlePath) {
    const detected = await detectBundleRoots(cwd)
    if (detected.length === 0) {
      throw new Error(
        "No bundle path provided and none auto-detected.\n" +
        "Usage: agent-cli skills bundle install <bundle-path>\n" +
        "Example: agent-cli skills bundle install ascend310p-operator-porting"
      )
    }
    bundlePath = detected[0]
    process.stdout.write(`Auto-detected bundle: ${bundlePath}\n`)
  }

  const targetPath = skillPath ?? config.agent.skillPaths[0]
  if (!targetPath) {
    throw new Error("No skill path configured. Set agent.skillPaths in agent-cli.config.json or pass --skill-path.")
  }

  const bundleAbs = path.resolve(cwd, bundlePath)
  const targetAbs = path.resolve(cwd, targetPath)

  const contents = await scanBundle(bundleAbs, targetAbs, cwd)

  const newSkills = contents.skillCandidates.filter((c) => !c.exists)
  const existingSkills = contents.skillCandidates.filter((c) => c.exists)

  process.stdout.write(`Bundle:  ${contents.bundleRootRel}\n`)
  process.stdout.write(`Target:  ${targetPath}\n`)
  process.stdout.write(`Install: ${contents.installRootRel}\n`)
  process.stdout.write(`Skills:  ${contents.skillCandidates.length} found (${newSkills.length} new, ${existingSkills.length} already present)\n`)
  process.stdout.write(`Hooks:   ${contents.hooksDetected} detected (not activated in P0)\n`)
  process.stdout.write(`Shared:  ${contents.hasShared ? "yes" : "no"}\n`)
  process.stdout.write(`Tools:   ${contents.executableToolsDetected} detected (not activated in P0)\n\n`)

  if (contents.skillCandidates.length > 0) {
    for (const c of contents.skillCandidates) {
      const marker = c.exists ? "  -" : "  +"
      const desc = c.description ? `  ${c.description.slice(0, 60)}${c.description.length > 60 ? "..." : ""}` : ""
      process.stdout.write(`${marker} ${c.name}${desc}\n`)
    }
    process.stdout.write("\n")
  }

  if (contents.hooksDetected > 0) {
    for (const h of contents.hookScripts) {
      const eventLabel = h.matcher ? `${h.event}(${h.matcher})` : h.event
      process.stdout.write(`  ~ ${h.name}  →  ${eventLabel}\n`)
    }
    process.stdout.write("  (copied as inert bundle resources; not activated in P0)\n\n")
  }

  if (dryRun) {
    process.stdout.write("(dry run — no files written)\n")
    return
  }

  if (newSkills.length === 0 && contents.hooksDetected === 0 && contents.componentTargets.length === 0) {
    process.stdout.write("Nothing to install - all skills already present and no bundle components found.\n")
    return
  }

  const result = await installBundle(bundleAbs, targetAbs, cwd)

  if (result.skillsImported > 0) {
    process.stdout.write(`Skills: ${result.skillsImported} imported`)
    if (result.skillsSkipped > 0) process.stdout.write(`, ${result.skillsSkipped} skipped`)
    if (result.skillsErrors > 0) process.stdout.write(`, ${result.skillsErrors} errors`)
    process.stdout.write("\n")
  }

  process.stdout.write(`Bundle resources copied: ${result.bundleResourcesCopied ? "yes" : "no"}\n`)
  process.stdout.write(`Executable tools detected: ${result.executableToolsDetected} (not activated)\n`)
  process.stdout.write(`Hooks detected: ${result.hooksDetected} (not activated)\n`)

  if (result.componentsCopied.length > 0) {
    process.stdout.write(`Components copied: ${result.componentsCopied.join(", ")} -> ${result.bundleRootPath}\n`)
  }
  if (result.componentErrors.length > 0) {
    for (const error of result.componentErrors) {
      process.stderr.write(`Component error: ${error}\n`)
    }
  }

  if (result.bundleRecordPath) process.stdout.write(`Bundle registered at ${result.bundleRecordPath}\n`)

  if (result.skillsErrors > 0 || result.componentErrors.length > 0) process.exitCode = 1
}

async function bundleList(): Promise<void> {
  const cwd = process.cwd()
  const bundles = await listInstalledBundles(cwd)

  if (bundles.length === 0) {
    process.stdout.write("No bundles installed. Use: agent-cli skills bundle install <bundle-path>\n")
    return
  }

  process.stdout.write("Installed bundles:\n")
  for (const b of bundles) {
    const date = b.installedAt.slice(0, 10)
    process.stdout.write(`  ${b.name}\n`)
    process.stdout.write(`    path:    ${b.rootRel}\n`)
    if (b.sourceRootRel) process.stdout.write(`    source:  ${b.sourceRootRel}\n`)
    process.stdout.write(`    skills:  ${b.skillsImported} imported\n`)
    process.stdout.write(`    hooks:   ${b.hooksDetected} detected (inactive)\n`)
    process.stdout.write(`    tools:   ${b.executableToolsDetected} detected (inactive)\n`)
    if (b.componentsCopied) process.stdout.write(`    parts:   ${b.componentsCopied.join(", ") || "none"}\n`)
    process.stdout.write(`    date:    ${date}\n`)
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  )
}

function printSkillsHelp(): void {
  process.stdout.write(`Manage agent skills (SKILL.md files in configured skill paths).

Usage:
  agent-cli skills list
  agent-cli skills add <name> [--description <desc>] [--body <text>] [--from-file <path>] [--skill-path <path>]
  agent-cli skills import [<bundle-path>] [--skill-path <path>] [--dry-run]
  agent-cli skills bundle install [<bundle-path>] [--skill-path <path>] [--dry-run]
  agent-cli skills bundle list
  agent-cli skills remove <name>

Options for "add":
  --description <desc>    One-line description shown to the agent in the system prompt
  --body <text>           Skill body content (inline text)
  --from-file <path>      Read skill body from a file
  --skill-path <path>     Target skill directory (default: first configured skillPath)

Options for "import" / "bundle install":
  <bundle-path>           Bundle root (auto-detected if omitted)
  --skill-path <path>     Target skill directory (default: first configured skillPath)
  --dry-run               Preview what would be installed without writing any files

"bundle install" does everything "import" does, plus:
  - Installs bundle components under .agents/bundles/<name>/
  - Copies hook/tool files only as inert resources; P0 never activates or executes them
  - Never changes .claude/settings.local.json
  - Registers the bundle in .agents/bundles.json for "bundle list"

Examples:
  agent-cli skills list
  agent-cli skills add bugfix --description "Systematic approach to diagnosing bugs"
  agent-cli skills import ascend310p-operator-porting/skills
  agent-cli skills bundle install ascend310p-operator-porting
  agent-cli skills bundle install ascend310p-operator-porting --dry-run
  agent-cli skills bundle list
  agent-cli skills remove bugfix
`)
}
