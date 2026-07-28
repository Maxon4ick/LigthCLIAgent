import { describe, expect, it } from "vitest"
import { scanText } from "../scripts/scan-secrets.mjs"

describe("secret scanner", () => {
  it("detects private keys without returning the value", () => {
    const secret = ["-----BEGIN ", "PRIVATE KEY-----"].join("")
    const findings = scanText(secret, "fixture.txt")
    expect(findings).toEqual([{ path: "fixture.txt", line: 1, rule: "private-key-header" }])
    expect(JSON.stringify(findings)).not.toContain(secret)
  })

  it("detects live-style API tokens", () => {
    const secret = ["sk-", "livevalue012345678901234567890123456789"].join("")
    expect(scanText(`token=${secret}`, "fixture.txt")).toEqual([
      { path: "fixture.txt", line: 1, rule: "openai-key" },
    ])
  })

  it("ignores documented placeholders", () => {
    expect(scanText('apiKey: "your-api-key-placeholder"', "README.md")).toEqual([])
    expect(scanText("Bearer example-token-placeholder-xxxxxxxxxxxxxxxxxxxxxxxx", "README.md")).toEqual([])
  })
})
