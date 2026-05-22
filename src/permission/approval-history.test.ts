import { describe, it, expect } from "vitest"
import { ApprovalHistoryStore, type ApprovalEntry } from "./approval-history.ts"

const ROOT_A = "ses_root_a"
const ROOT_B = "ses_root_b"

function entry(partial: Partial<ApprovalEntry> = {}): ApprovalEntry {
  return {
    subject: "git status",
    subjectLabel: "command",
    response: "once",
    classifierVerdict: "RISKY",
    classifierReason: "unclear intent",
    timestamp: 1_000,
    ...partial,
  }
}

describe("ApprovalHistoryStore", () => {
  it("returns an empty array for an unknown root session", () => {
    const store = new ApprovalHistoryStore()
    expect(store.recent(ROOT_A, 10)).toEqual([])
  })

  it("records and returns entries in newest-first order", () => {
    const store = new ApprovalHistoryStore()
    store.record(ROOT_A, entry({ subject: "first", timestamp: 1 }))
    store.record(ROOT_A, entry({ subject: "second", timestamp: 2 }))
    store.record(ROOT_A, entry({ subject: "third", timestamp: 3 }))

    const got = store.recent(ROOT_A, 10)
    expect(got.map((e) => e.subject)).toEqual(["third", "second", "first"])
  })

  it("honours the per-session entry cap, evicting oldest first", () => {
    const store = new ApprovalHistoryStore({ maxPerSession: 3 })
    for (let i = 0; i < 5; i++) {
      store.record(ROOT_A, entry({ subject: `cmd-${i}`, timestamp: i }))
    }
    const got = store.recent(ROOT_A, 10)
    // Oldest two evicted; newest three remain in newest-first order.
    expect(got.map((e) => e.subject)).toEqual(["cmd-4", "cmd-3", "cmd-2"])
  })

  it("scopes entries by root session ID", () => {
    const store = new ApprovalHistoryStore()
    store.record(ROOT_A, entry({ subject: "for A" }))
    store.record(ROOT_B, entry({ subject: "for B" }))

    expect(store.recent(ROOT_A, 10).map((e) => e.subject)).toEqual(["for A"])
    expect(store.recent(ROOT_B, 10).map((e) => e.subject)).toEqual(["for B"])
  })

  it("limits the result to the requested count", () => {
    const store = new ApprovalHistoryStore()
    for (let i = 0; i < 5; i++) {
      store.record(ROOT_A, entry({ subject: `cmd-${i}`, timestamp: i }))
    }
    expect(store.recent(ROOT_A, 2).map((e) => e.subject)).toEqual([
      "cmd-4",
      "cmd-3",
    ])
  })

  it("returns an empty array when the requested count is zero or negative", () => {
    const store = new ApprovalHistoryStore()
    store.record(ROOT_A, entry())
    expect(store.recent(ROOT_A, 0)).toEqual([])
    expect(store.recent(ROOT_A, -1)).toEqual([])
  })

  it("enforces a global LRU cap on the number of sessions tracked", () => {
    const store = new ApprovalHistoryStore({
      maxPerSession: 5,
      maxSessions: 2,
    })
    store.record("ses_1", entry({ subject: "in 1" }))
    store.record("ses_2", entry({ subject: "in 2" }))
    // Adding a third session should evict the least-recently-used (ses_1).
    store.record("ses_3", entry({ subject: "in 3" }))

    expect(store.recent("ses_1", 10)).toEqual([])
    expect(store.recent("ses_2", 10).map((e) => e.subject)).toEqual(["in 2"])
    expect(store.recent("ses_3", 10).map((e) => e.subject)).toEqual(["in 3"])
  })

  it("touches a session on record so recent recording resets LRU position", () => {
    const store = new ApprovalHistoryStore({
      maxPerSession: 5,
      maxSessions: 2,
    })
    store.record("ses_1", entry({ subject: "in 1" }))
    store.record("ses_2", entry({ subject: "in 2" }))
    // Touch ses_1 again — it should now be the most recently used.
    store.record("ses_1", entry({ subject: "in 1 again" }))
    // Adding ses_3 should evict ses_2 (now the LRU), not ses_1.
    store.record("ses_3", entry({ subject: "in 3" }))

    expect(store.recent("ses_1", 10).map((e) => e.subject)).toEqual([
      "in 1 again",
      "in 1",
    ])
    expect(store.recent("ses_2", 10)).toEqual([])
    expect(store.recent("ses_3", 10).map((e) => e.subject)).toEqual(["in 3"])
  })
})
