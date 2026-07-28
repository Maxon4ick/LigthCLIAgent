import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("HTTP adapter boundary", () => {
  it("keeps core free of HTTP and loads serve lazily", async () => {
    const runtime = await readFile("src/core/runtime.ts", "utf8")
    const cli = await readFile("src/cli/index.ts", "utf8")
    const serve = await readFile("src/cli/commands/serve.ts", "utf8")
    expect(runtime).not.toMatch(/adapters\/http|node:http|server\//)
    expect(cli).not.toMatch(/^import .*commands\/serve/m)
    expect(cli).toContain('await import("./commands/serve.js")')
    expect(serve).toContain('await import("../../adapters/http/index.js")')
  })
})
