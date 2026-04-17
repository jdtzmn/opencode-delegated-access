import { describe, it, expect } from "vitest"
import { parseVerdict } from "./parse.ts"

describe("parseVerdict", () => {
  it("parses a well-formed SAFE response", () => {
    const text = "VERDICT: SAFE\nREASON: Read-only inspection of project files."
    expect(parseVerdict(text)).toEqual({
      verdict: "SAFE",
      reason: "Read-only inspection of project files.",
    })
  })

  it("parses a well-formed RISKY response", () => {
    const text = "VERDICT: RISKY\nREASON: Destructive rm -rf outside build directory."
    expect(parseVerdict(text)).toEqual({
      verdict: "RISKY",
      reason: "Destructive rm -rf outside build directory.",
    })
  })

  it("is case-insensitive on the verdict token", () => {
    const text = "verdict: safe\nreason: ok"
    expect(parseVerdict(text)?.verdict).toBe("SAFE")
  })

  it("tolerates surrounding whitespace and blank lines", () => {
    const text = "\n\n  VERDICT: RISKY  \n\n  REASON:   privileged operation  \n\n"
    expect(parseVerdict(text)).toEqual({
      verdict: "RISKY",
      reason: "privileged operation",
    })
  })

  it("tolerates leading chatty preamble and extracts the first VERDICT", () => {
    const text =
      "Sure, here is my analysis.\nVERDICT: SAFE\nREASON: git status is read-only."
    expect(parseVerdict(text)?.verdict).toBe("SAFE")
  })

  it("returns null when the verdict is missing", () => {
    expect(parseVerdict("REASON: something went wrong")).toBeNull()
  })

  it("returns null when the verdict value is unrecognised", () => {
    expect(parseVerdict("VERDICT: MAYBE\nREASON: unsure")).toBeNull()
  })

  it("returns null for empty input", () => {
    expect(parseVerdict("")).toBeNull()
  })

  it("uses a fallback reason when REASON line is missing", () => {
    const text = "VERDICT: SAFE"
    const parsed = parseVerdict(text)
    expect(parsed?.verdict).toBe("SAFE")
    expect(parsed?.reason).toBe("")
  })

  it("truncates excessively long reason strings", () => {
    const longReason = "x".repeat(2000)
    const text = `VERDICT: RISKY\nREASON: ${longReason}`
    const parsed = parseVerdict(text)
    expect(parsed?.verdict).toBe("RISKY")
    // Sanity upper bound; exact cap documented in implementation.
    expect(parsed?.reason.length).toBeLessThanOrEqual(500)
  })

  it("stops reason at the first newline (does not capture multi-line)", () => {
    const text = "VERDICT: SAFE\nREASON: first line\nextra trailing garbage"
    expect(parseVerdict(text)?.reason).toBe("first line")
  })

  it("returns null when verdict token appears but no valid value follows", () => {
    expect(parseVerdict("VERDICT:\nREASON: nothing")).toBeNull()
  })
})
