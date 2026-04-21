import { describe, it, expect } from "vitest"
import { DirectoryVerdictCache } from "./directory-cache.ts"
import type { Verdict } from "../classifier/parse.ts"

const SAFE: Verdict = { verdict: "SAFE", reason: "user asked for this dir" }
const RISKY: Verdict = { verdict: "RISKY", reason: "sensitive path" }

const KEY = "/Users/jacob/Documents/GitHub/premind/*"
const TTL = 60_000

describe("DirectoryVerdictCache", () => {
  it("returns null for a key that was never set", () => {
    const cache = new DirectoryVerdictCache()
    expect(cache.get(KEY)).toBeNull()
  })

  it("returns the stored SAFE verdict before TTL expires", () => {
    let now = 1_000
    const cache = new DirectoryVerdictCache(() => now)
    cache.set(KEY, SAFE, TTL)

    now = 1_000 + TTL - 1 // 1 ms before expiry
    const entry = cache.get(KEY)
    expect(entry).not.toBeNull()
    expect(entry?.verdict).toEqual(SAFE)
  })

  it("returns null after TTL expires", () => {
    let now = 1_000
    const cache = new DirectoryVerdictCache(() => now)
    cache.set(KEY, SAFE, TTL)

    now = 1_000 + TTL // exactly at expiry
    expect(cache.get(KEY)).toBeNull()
  })

  it("does NOT cache RISKY verdicts", () => {
    const cache = new DirectoryVerdictCache()
    cache.set(KEY, RISKY, TTL)
    expect(cache.get(KEY)).toBeNull()
  })

  it("evicts the expired entry on get so it does not reappear", () => {
    let now = 1_000
    const cache = new DirectoryVerdictCache(() => now)
    cache.set(KEY, SAFE, TTL)

    now = 1_000 + TTL + 1 // expired
    expect(cache.get(KEY)).toBeNull()

    // Entry must be gone from the internal map (checked via size).
    expect(cache.size).toBe(0)
  })

  it("can store and retrieve multiple independent keys", () => {
    const cache = new DirectoryVerdictCache()
    const key2 = "/Users/jacob/Documents/GitHub/other/*"
    cache.set(KEY, SAFE, TTL)
    cache.set(key2, { verdict: "SAFE", reason: "also fine" }, TTL)

    expect(cache.get(KEY)?.verdict.reason).toBe("user asked for this dir")
    expect(cache.get(key2)?.verdict.reason).toBe("also fine")
  })

  it("overwrites an existing entry with a fresh TTL on re-set", () => {
    let now = 1_000
    const cache = new DirectoryVerdictCache(() => now)
    cache.set(KEY, SAFE, TTL)

    // Advance close to expiry, then re-set with a fresh TTL.
    now = 1_000 + TTL - 100
    const fresh: Verdict = { verdict: "SAFE", reason: "refreshed" }
    cache.set(KEY, fresh, TTL)

    // Advance past the original expiry — should still be valid.
    now = 1_000 + TTL + 1
    const entry = cache.get(KEY)
    expect(entry).not.toBeNull()
    expect(entry?.verdict.reason).toBe("refreshed")
  })

  it("size reflects only unexpired entries", () => {
    let now = 1_000
    const cache = new DirectoryVerdictCache(() => now)
    cache.set(KEY, SAFE, TTL)
    cache.set("/tmp/*", { verdict: "SAFE", reason: "tmp" }, 500) // short TTL

    expect(cache.size).toBe(2)

    now = 1_600 // past the 500ms TTL, within 60s TTL
    expect(cache.size).toBe(1)
  })

  describe("DirectoryVerdictCache.keyFor", () => {
    it("returns the single pattern for a 1-element array", () => {
      expect(DirectoryVerdictCache.keyFor(["/foo/*"])).toBe("/foo/*")
    })

    it("joins multiple patterns with a NUL-byte separator", () => {
      expect(DirectoryVerdictCache.keyFor(["/foo/*", "/bar/*"])).toBe(
        "/foo/*\u0001/bar/*",
      )
    })

    it("produces distinct keys for different arrays", () => {
      const a = DirectoryVerdictCache.keyFor(["/foo/*"])
      const b = DirectoryVerdictCache.keyFor(["/bar/*"])
      expect(a).not.toBe(b)
    })
  })
})
