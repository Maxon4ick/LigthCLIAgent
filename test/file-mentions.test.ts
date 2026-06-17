import { mkdtemp, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { normalizePromptFileMentions } from "../src/core/context/file-mentions.js"

describe("@file prompt mentions", () => {
  it("inlines workspace text files and skips protected paths", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-mentions-"))
    await writeFile(path.join(cwd, "README.md"), "# Hello\n", "utf8")
    await writeFile(path.join(cwd, ".env"), "OPENAI_API_KEY=sk-secretsecretsecretsecret", "utf8")

    const result = await normalizePromptFileMentions(cwd, "review @README.md and @.env")

    expect(result.prompt).toContain("<file_mentions>")
    expect(result.prompt).toContain("<file path=\"README.md\"")
    expect(result.prompt).toContain("# Hello")
    expect(result.prompt).not.toContain("sk-secret")
    expect(result.mentions).toMatchObject([
      { path: "README.md", status: "inlined" },
      { path: ".env", status: "skipped" },
    ])
  })

  it("skips mentions whose real path is protected", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-cli-mentions-symlink-"))
    await writeFile(path.join(cwd, ".env"), "OPENAI_API_KEY=sk-secretsecretsecretsecret", "utf8")

    try {
      await symlink(path.join(cwd, ".env"), path.join(cwd, "public.txt"), "file")
    } catch (error) {
      if (isSymlinkPrivilegeError(error)) return
      throw error
    }

    const result = await normalizePromptFileMentions(cwd, "review @public.txt")

    expect(result.prompt).not.toContain("<file_mentions>")
    expect(result.prompt).not.toContain("sk-secret")
    expect(result.mentions).toMatchObject([
      {
        path: "public.txt",
        status: "skipped",
        reason: "protected path requires the read_file tool and permission policy",
      },
    ])
  })
})

function isSymlinkPrivilegeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "EPERM" || (error as { code?: string }).code === "EACCES")
  )
}
