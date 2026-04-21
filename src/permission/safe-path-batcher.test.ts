import { describe, it, expect, vi, beforeEach } from "vitest"
import { SafePathBatcher } from "./safe-path-batcher.ts"
import type { NotifyActionResult, NotifyArgs } from "../notify/notify.ts"
import type { SafePathOutcome } from "./safe-path.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock sendNotification that resolves with the given result. */
function makeSend(result: NotifyActionResult) {
  return vi.fn(async () => result)
}

const DEFAULT_COUNTDOWN = 5_000
const BATCH_WINDOW = 200

function makeBatcher(
  send = makeSend({ type: "timeout" }),
  batchWindowMs = BATCH_WINDOW,
) {
  const batcher = new SafePathBatcher({
    batchWindowMs,
    sendNotification: send as SafePathBatcher["sendNotification"],
    countdownMs: DEFAULT_COUNTDOWN,
    sound: false,
  })
  return { batcher, send }
}

// ---------------------------------------------------------------------------
// Core behaviour
// ---------------------------------------------------------------------------

describe("SafePathBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it("enqueues one item, fires notification after batchWindowMs, resolves allow on timeout", async () => {
    const send = makeSend({ type: "timeout" })
    const { batcher } = makeBatcher(send)

    const p = batcher.enqueue("uname -a")

    // Notification not yet sent — still inside the batch window.
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()

    const result = await p
    expect(result).toBe<SafePathOutcome>("allow")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("resolves 'ask' when the notification is cancelled (user clicked Cancel)", async () => {
    const { batcher, send } = makeBatcher(makeSend({ type: "action", label: "Cancel" }))

    const p = batcher.enqueue("git status")
    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()

    expect(await p).toBe<SafePathOutcome>("ask")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("resolves 'ask' when notification is dismissed (cancel activationType)", async () => {
    const { batcher } = makeBatcher(makeSend({ type: "cancel" }))
    const p = batcher.enqueue("ls")
    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()
    expect(await p).toBe<SafePathOutcome>("ask")
  })

  it("resolves 'allow' on notification error (fail-open: classifier already said SAFE)", async () => {
    const { batcher } = makeBatcher(makeSend({ type: "error", error: new Error("no display") }))
    const p = batcher.enqueue("ls")
    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()
    expect(await p).toBe<SafePathOutcome>("allow")
  })

  // ---------------------------------------------------------------------------
  // Batching behaviour
  // ---------------------------------------------------------------------------

  it("batches multiple items arriving within the window into a single notification", async () => {
    const send = makeSend({ type: "timeout" })
    const { batcher } = makeBatcher(send)

    const p1 = batcher.enqueue("premind/*")
    const p2 = batcher.enqueue("premind/src/*")
    const p3 = batcher.enqueue("premind/src/daemon/*")

    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()

    // All three resolved
    expect(await Promise.all([p1, p2, p3])).toEqual(["allow", "allow", "allow"])
    // But only ONE notification was sent
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("all items in a batch resolve 'ask' when user cancels", async () => {
    const { batcher } = makeBatcher(makeSend({ type: "cancel" }))

    const promises = [
      batcher.enqueue("a/*"),
      batcher.enqueue("b/*"),
      batcher.enqueue("c/*"),
    ]

    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()

    const results = await Promise.all(promises)
    for (const r of results) {
      expect(r).toBe<SafePathOutcome>("ask")
    }
  })

  it("shows '(+N more)' in notification message when N>1 items are batched", async () => {
    const send = makeSend({ type: "timeout" })
    const { batcher } = makeBatcher(send)

    batcher.enqueue("premind/*")
    batcher.enqueue("premind/src/*")
    batcher.enqueue("premind/src/daemon/*")

    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()

    const callArgs = (send.mock.calls as unknown as NotifyArgs[][])[0]?.[0]
    expect(callArgs?.message).toMatch(/\(\+2 more\)/)
  })

  it("uses plain subject text (no '+N more') for single-item batch", async () => {
    const send = makeSend({ type: "timeout" })
    const { batcher } = makeBatcher(send)

    batcher.enqueue("uname -a")
    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()

    const callArgs = (send.mock.calls as unknown as NotifyArgs[][])[0]?.[0]
    expect(callArgs?.message).not.toMatch(/\+\d+ more/)
    expect(callArgs?.message).toContain("uname -a")
  })

  it("items arriving after the window starts a new batch", async () => {
    const send = makeSend({ type: "timeout" })
    const { batcher } = makeBatcher(send)

    const p1 = batcher.enqueue("batch-1-item")

    // Flush batch 1
    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()
    expect(await p1).toBe("allow")
    expect(send).toHaveBeenCalledTimes(1)

    // Now enqueue a second item — starts a new batch
    const p2 = batcher.enqueue("batch-2-item")
    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()
    expect(await p2).toBe("allow")
    expect(send).toHaveBeenCalledTimes(2)
  })

  // ---------------------------------------------------------------------------
  // countdownMs: 0 bypass
  // ---------------------------------------------------------------------------

  it("resolves immediately as 'allow' without calling sendNotification when countdownMs is 0", async () => {
    const send = makeSend({ type: "timeout" })
    const batcher = new SafePathBatcher({
      batchWindowMs: BATCH_WINDOW,
      sendNotification: send as SafePathBatcher["sendNotification"],
      countdownMs: 0,
      sound: false,
    })

    const result = await batcher.enqueue("ls")
    expect(result).toBe<SafePathOutcome>("allow")
    expect(send).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Notification options
  // ---------------------------------------------------------------------------

  it("passes the countdown timeout in seconds to sendNotification", async () => {
    const send = makeSend({ type: "timeout" })
    const batcher = new SafePathBatcher({
      batchWindowMs: BATCH_WINDOW,
      sendNotification: send as SafePathBatcher["sendNotification"],
      countdownMs: 7_000,
      sound: true,
    })

    batcher.enqueue("ls")
    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()

    const callArgs = (send.mock.calls as unknown as NotifyArgs[][])[0]?.[0]
    expect(callArgs?.timeoutSec).toBe(7)
  })

  it("passes sound setting to sendNotification", async () => {
    const send = makeSend({ type: "timeout" })
    const batcher = new SafePathBatcher({
      batchWindowMs: BATCH_WINDOW,
      sendNotification: send as SafePathBatcher["sendNotification"],
      countdownMs: 5_000,
      sound: true,
    })

    batcher.enqueue("ls")
    vi.advanceTimersByTime(BATCH_WINDOW)
    await vi.runAllTimersAsync()

    const callArgs = (send.mock.calls as unknown as NotifyArgs[][])[0]?.[0]
    expect(callArgs?.sound).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Batch cancel semantics — concurrent enqueues, isolated test
// ---------------------------------------------------------------------------

describe("SafePathBatcher batch cancel", () => {
  it("all items in the same batch resolve 'ask' when notification is cancelled", async () => {
    vi.useFakeTimers()
    const send = vi.fn(async () => ({ type: "cancel" } as NotifyActionResult))
    const batcher = new SafePathBatcher({
      batchWindowMs: 200,
      sendNotification: send as SafePathBatcher["sendNotification"],
      countdownMs: 5_000,
      sound: false,
    })

    const promises = [
      batcher.enqueue("premind/*"),
      batcher.enqueue("premind/src/*"),
      batcher.enqueue("premind/src/daemon/*"),
    ]

    vi.advanceTimersByTime(200)
    await vi.runAllTimersAsync()

    const results = await Promise.all(promises)
    expect(results).toEqual(["ask", "ask", "ask"])
    expect(send).toHaveBeenCalledTimes(1)
  })
})
