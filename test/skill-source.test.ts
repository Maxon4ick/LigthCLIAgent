import { describe, expect, it } from "vitest"
import { EventBus } from "../src/core/events/event-bus.js"
import {
  loadIndexedSkill,
  loadSkillIndex,
  resolveSkill,
  type SkillSourceProvider,
} from "../src/core/context/skills.js"
import { defaultConfig } from "../src/core/config/schema.js"

describe("SkillSource", () => {
  it("supports qualified lookup and reports ambiguous unqualified names", async () => {
    const source = (id: string, priority: number): SkillSourceProvider => ({
      id,
      priority,
      discover: () => [{
        id: `${id}:guide`,
        name: "guide",
        description: `${id} guide`,
        sourceId: id,
        location: `memory://${id}/guide`,
        provenance: "directory",
      }],
      load: (skill, context) => ({ ...skill, body: `${id}:${context.resource ?? "body"}` }),
    })
    const index = await loadSkillIndex(process.cwd(), [source("high", 10), source("low", 1)])
    expect(() => resolveSkill(index, "guide")).toThrow("ambiguous")
    const selected = resolveSkill(index, "high:guide")
    const loaded = await loadIndexedSkill(index, selected, {
      cwd: process.cwd(),
      config: defaultConfig,
      events: new EventBus(),
      abortSignal: new AbortController().signal,
      resource: "notes.md",
    })
    expect(loaded.body).toBe("high:notes.md")
    expect(index.skills.map((skill) => skill.id)).toEqual(["high:guide", "low:guide"])
  })
})
