import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"

describe("lightweight public import", () => {
  it("runs a memory prompt without loading optional adapters", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-cli-import-trace-"))
    const tracePath = path.join(scratch, "modules.txt")
    const loaderPath = path.join(scratch, "loader.mjs")
    const probePath = path.join(scratch, "probe.mjs")
    try {
    await writeFile(
      loaderPath,
      `import { appendFileSync } from "node:fs"
       export async function load(url, context, nextLoad) {
         if (url.startsWith("file:")) appendFileSync(process.env.AGENT_CLI_TRACE, url + "\\n")
         return nextLoad(url, context)
       }`,
      "utf8",
    )
    const entry = pathToFileURL(path.resolve("src/index.ts")).href
    await writeFile(
      probePath,
      `import { createRuntime, createSession, addUserPrompt, defaultConfig, mergeConfig } from ${JSON.stringify(entry)}
       const config = mergeConfig(defaultConfig, { storage: { kind: "memory" } })
       const runtime = await createRuntime({ config, cwd: process.cwd() })
       const session = createSession(runtime)
       addUserPrompt(runtime, session.id, "hello")
       const result = await runtime.startSession(session.id).promise
       if (!result.assistantText.includes("Mock response")) throw new Error("mock failed")
       await runtime.dispose()`,
      "utf8",
    )

    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--experimental-loader",
        pathToFileURL(loaderPath).href,
        "--input-type=module",
        "--eval",
        `import(${JSON.stringify(pathToFileURL(probePath).href)})`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_CLI_TRACE: tracePath },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    const trace = (await readFile(tracePath, "utf8")).replaceAll("\\", "/")
    expect(trace).not.toMatch(/\/src\/adapters\/(?:http|tui|sqlite|mcp|local)\//)
    expect(trace).not.toContain("better-sqlite3")
    expect(trace).not.toContain("@modelcontextprotocol/sdk")
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
