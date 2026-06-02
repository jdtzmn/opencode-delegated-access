import { describe, it, expect } from "vitest"
import {
  EphemeralSystemRegistry,
  applyEphemeralSystemTransform,
} from "./ephemeral-system.ts"

describe("EphemeralSystemRegistry", () => {
  it("returns undefined for an unregistered session", () => {
    const reg = new EphemeralSystemRegistry()
    expect(reg.get("sess_x")).toBeUndefined()
  })

  it("stores and retrieves a registered system prompt", () => {
    const reg = new EphemeralSystemRegistry()
    reg.set("sess_x", "CLASSIFIER PROMPT")
    expect(reg.get("sess_x")).toBe("CLASSIFIER PROMPT")
  })

  it("deletes a registered prompt", () => {
    const reg = new EphemeralSystemRegistry()
    reg.set("sess_x", "P")
    reg.delete("sess_x")
    expect(reg.get("sess_x")).toBeUndefined()
  })

  it("reports membership via has()", () => {
    const reg = new EphemeralSystemRegistry()
    expect(reg.has("sess_x")).toBe(false)
    reg.set("sess_x", "P")
    expect(reg.has("sess_x")).toBe(true)
  })
})

describe("applyEphemeralSystemTransform", () => {
  it("replaces the system array with ONLY the classifier prompt for a registered ephemeral session", () => {
    const reg = new EphemeralSystemRegistry()
    reg.set("sess_eph", "You are a safety classifier. Output VERDICT.")
    const output = {
      system: [
        "You are an agent. You MUST invoke the using-superpowers skill.",
        "AGENTS.md global instructions...",
        "model default prompt",
      ],
    }

    applyEphemeralSystemTransform(
      { sessionID: "sess_eph" },
      output,
      reg,
    )

    expect(output.system).toEqual([
      "You are a safety classifier. Output VERDICT.",
    ])
  })

  it("leaves the system array untouched for a non-ephemeral session", () => {
    const reg = new EphemeralSystemRegistry()
    reg.set("sess_eph", "classifier prompt")
    const original = ["agent preamble", "global instructions"]
    const output = { system: [...original] }

    applyEphemeralSystemTransform(
      { sessionID: "sess_other" },
      output,
      reg,
    )

    expect(output.system).toEqual(original)
  })

  it("leaves the system array untouched when sessionID is missing", () => {
    const reg = new EphemeralSystemRegistry()
    reg.set("sess_eph", "classifier prompt")
    const original = ["agent preamble"]
    const output = { system: [...original] }

    applyEphemeralSystemTransform({ sessionID: undefined }, output, reg)

    expect(output.system).toEqual(original)
  })

  it("mutates the SAME array reference in place (opencode reads output.system by reference)", () => {
    const reg = new EphemeralSystemRegistry()
    reg.set("sess_eph", "classifier prompt")
    const output = { system: ["a", "b", "c"] }
    const ref = output.system

    applyEphemeralSystemTransform({ sessionID: "sess_eph" }, output, reg)

    // Same array object, contents replaced — so opencode sees the change
    // even if it captured the reference before the hook ran.
    expect(output.system).toBe(ref)
    expect(ref).toEqual(["classifier prompt"])
  })
})
