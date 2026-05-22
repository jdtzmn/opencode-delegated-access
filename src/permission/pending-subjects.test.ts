import { describe, it, expect } from "vitest"
import { PendingSubjectsMap, type PendingSubject } from "./pending-subjects.ts"

const TTL = 60 * 60 * 1_000 // 1 hour

function pending(partial: Partial<PendingSubject> = {}): PendingSubject {
  return {
    rootSessionID: "ses_root",
    subject: "git status",
    subjectLabel: "command",
    classifierVerdict: null,
    classifierReason: null,
    autoApproved: false,
    ...partial,
  }
}

describe("PendingSubjectsMap", () => {
  it("returns null for an unknown permission ID", () => {
    const map = new PendingSubjectsMap()
    expect(map.take("perm_missing")).toBeNull()
  })

  it("stores and retrieves a pending entry exactly once", () => {
    const map = new PendingSubjectsMap()
    map.set("perm_1", pending({ subject: "ls" }))

    const taken = map.take("perm_1")
    expect(taken?.subject).toBe("ls")
    // Once taken, it's gone.
    expect(map.take("perm_1")).toBeNull()
  })

  it("allows in-place updates via update()", () => {
    const map = new PendingSubjectsMap()
    map.set("perm_1", pending({ subject: "ls", classifierVerdict: null }))

    map.update("perm_1", (cur) => ({
      ...cur,
      classifierVerdict: "SAFE",
      classifierReason: "read-only",
    }))

    const taken = map.take("perm_1")
    expect(taken?.classifierVerdict).toBe("SAFE")
    expect(taken?.classifierReason).toBe("read-only")
    expect(taken?.subject).toBe("ls")
  })

  it("update() is a no-op if the key is missing", () => {
    const map = new PendingSubjectsMap()
    map.update("perm_missing", (cur) => ({ ...cur, autoApproved: true }))
    expect(map.take("perm_missing")).toBeNull()
  })

  it("evicts entries older than the TTL on take()", () => {
    let now = 1_000
    const map = new PendingSubjectsMap({ ttlMs: TTL, now: () => now })
    map.set("perm_1", pending({ subject: "ls" }))

    now = 1_000 + TTL + 1
    expect(map.take("perm_1")).toBeNull()
  })

  it("does not evict entries within the TTL", () => {
    let now = 1_000
    const map = new PendingSubjectsMap({ ttlMs: TTL, now: () => now })
    map.set("perm_1", pending({ subject: "ls" }))

    now = 1_000 + TTL - 1
    expect(map.take("perm_1")?.subject).toBe("ls")
  })

  it("sweep() drops expired entries proactively", () => {
    let now = 1_000
    const map = new PendingSubjectsMap({ ttlMs: TTL, now: () => now })
    map.set("perm_old", pending({ subject: "old" }))

    now = 1_000 + TTL + 1
    map.set("perm_new", pending({ subject: "new" }))
    map.sweep()

    expect(map.take("perm_old")).toBeNull()
    expect(map.take("perm_new")?.subject).toBe("new")
  })

  it("size reports the count of unexpired entries", () => {
    let now = 1_000
    const map = new PendingSubjectsMap({ ttlMs: TTL, now: () => now })
    map.set("a", pending())
    map.set("b", pending())
    expect(map.size).toBe(2)

    now = 1_000 + TTL + 1
    // Lazy sweep happens on next size call.
    expect(map.size).toBe(0)
  })
})
