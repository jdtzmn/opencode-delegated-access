import { describe, it, expect } from "vitest"
import { ConfigSchema, parseConfig, DEFAULT_CONFIG } from "./config.ts"

describe("ConfigSchema", () => {
  it("returns defaults when given an empty object", () => {
    const parsed = ConfigSchema.parse({})
    expect(parsed).toEqual(DEFAULT_CONFIG)
  })

  it("returns defaults when given undefined", () => {
    const parsed = parseConfig(undefined)
    expect(parsed).toEqual(DEFAULT_CONFIG)
  })

  it("accepts a fully-specified valid config", () => {
    const input = {
      enabled: false,
      contextMessageCount: 5,
      safeCountdownMs: 3000,
      classifierModel: "anthropic/claude-haiku-4-5",
      classifierTimeoutMs: 8000,
      notificationSound: false,
    }
    expect(ConfigSchema.parse(input)).toEqual(input)
  })

  it("allows classifierModel to be omitted", () => {
    const parsed = ConfigSchema.parse({ enabled: true })
    expect(parsed.classifierModel).toBeUndefined()
  })

  it("rejects negative contextMessageCount", () => {
    expect(() => ConfigSchema.parse({ contextMessageCount: -1 })).toThrow()
  })

  it("rejects non-integer contextMessageCount", () => {
    expect(() => ConfigSchema.parse({ contextMessageCount: 2.5 })).toThrow()
  })

  it("rejects contextMessageCount above 20 (sanity bound)", () => {
    expect(() => ConfigSchema.parse({ contextMessageCount: 21 })).toThrow()
  })

  it("rejects negative safeCountdownMs", () => {
    expect(() => ConfigSchema.parse({ safeCountdownMs: -100 })).toThrow()
  })

  it("rejects classifierTimeoutMs below the minimum", () => {
    expect(() => ConfigSchema.parse({ classifierTimeoutMs: 100 })).toThrow()
  })

  it("rejects non-string classifierModel", () => {
    expect(() => ConfigSchema.parse({ classifierModel: 42 })).toThrow()
  })

  it("parseConfig throws on invalid shape with a clear error path", () => {
    expect(() => parseConfig({ enabled: "yes" })).toThrow(/enabled/)
  })

  it("DEFAULT_CONFIG has stable documented defaults", () => {
    expect(DEFAULT_CONFIG).toEqual({
      enabled: true,
      contextMessageCount: 3,
      safeCountdownMs: 5000,
      classifierTimeoutMs: 5000,
      notificationSound: true,
    })
  })
})
