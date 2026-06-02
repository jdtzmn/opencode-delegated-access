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
      classifierRetries: 2,
      notificationSound: false,
      externalDirectoryEnabled: false,
      directoryVerdictCacheTtlMs: 30_000,
      approvalHistoryEnabled: false,
      approvalHistoryMax: 100,
      notifyOnClassifierFailure: false,
      classifierFailureNotifyCooldownMs: 30_000,
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
      classifierTimeoutMs: 15_000,
      classifierRetries: 1,
      notificationSound: true,
      externalDirectoryEnabled: true,
      directoryVerdictCacheTtlMs: 60_000,
      approvalHistoryEnabled: true,
      approvalHistoryMax: 20,
      notifyOnClassifierFailure: true,
      classifierFailureNotifyCooldownMs: 60_000,
    })
  })

  it("rejects directoryVerdictCacheTtlMs above the maximum", () => {
    expect(() =>
      ConfigSchema.parse({ directoryVerdictCacheTtlMs: 300_001 }),
    ).toThrow()
  })

  it("rejects negative directoryVerdictCacheTtlMs", () => {
    expect(() =>
      ConfigSchema.parse({ directoryVerdictCacheTtlMs: -1 }),
    ).toThrow()
  })
})

describe("approvalHistory options", () => {
  it("defaults approvalHistoryEnabled to true", () => {
    const c = parseConfig({})
    expect(c.approvalHistoryEnabled).toBe(true)
  })

  it("defaults approvalHistoryMax to 20", () => {
    const c = parseConfig({})
    expect(c.approvalHistoryMax).toBe(20)
  })

  it("accepts approvalHistoryEnabled = false", () => {
    const c = parseConfig({ approvalHistoryEnabled: false })
    expect(c.approvalHistoryEnabled).toBe(false)
  })

  it("clamps approvalHistoryMax to its allowed range", () => {
    expect(() => parseConfig({ approvalHistoryMax: -1 })).toThrow()
    expect(() => parseConfig({ approvalHistoryMax: 1001 })).toThrow()
    expect(parseConfig({ approvalHistoryMax: 0 }).approvalHistoryMax).toBe(0)
    expect(parseConfig({ approvalHistoryMax: 50 }).approvalHistoryMax).toBe(50)
  })
})

describe("classifier retry / failure-notification options", () => {
  it("defaults classifierRetries to 1", () => {
    expect(parseConfig({}).classifierRetries).toBe(1)
  })

  it("accepts classifierRetries = 0 (disable retry)", () => {
    expect(parseConfig({ classifierRetries: 0 }).classifierRetries).toBe(0)
  })

  it("rejects negative classifierRetries", () => {
    expect(() => parseConfig({ classifierRetries: -1 })).toThrow()
  })

  it("rejects non-integer classifierRetries", () => {
    expect(() => parseConfig({ classifierRetries: 1.5 })).toThrow()
  })

  it("rejects classifierRetries above the sanity bound", () => {
    expect(() => parseConfig({ classifierRetries: 11 })).toThrow()
  })

  it("defaults notifyOnClassifierFailure to true", () => {
    expect(parseConfig({}).notifyOnClassifierFailure).toBe(true)
  })

  it("accepts notifyOnClassifierFailure = false", () => {
    expect(parseConfig({ notifyOnClassifierFailure: false }).notifyOnClassifierFailure).toBe(false)
  })

  it("defaults classifierFailureNotifyCooldownMs to 60000", () => {
    expect(parseConfig({}).classifierFailureNotifyCooldownMs).toBe(60_000)
  })

  it("accepts classifierFailureNotifyCooldownMs = 0 (no rate limit)", () => {
    expect(
      parseConfig({ classifierFailureNotifyCooldownMs: 0 })
        .classifierFailureNotifyCooldownMs,
    ).toBe(0)
  })

  it("rejects negative classifierFailureNotifyCooldownMs", () => {
    expect(() =>
      parseConfig({ classifierFailureNotifyCooldownMs: -1 }),
    ).toThrow()
  })
})
