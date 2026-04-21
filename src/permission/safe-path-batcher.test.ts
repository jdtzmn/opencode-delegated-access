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

// ---------------------------------------------------------------------------
// Flushing guard — items arriving while a notification is in-flight must not
// trigger a second concurrent notification (the core macOS race condition)
// ---------------------------------------------------------------------------

describe("SafePathBatcher flushing guard", () => {
  it("does not start a second notification while the first is still active", async () => {
    vi.useFakeTimers()

    // Each call to send gets its own manually-resolved promise so we can
    // sequence them precisely.
    const resolvers: Array<(r: NotifyActionResult) => void> = []
    const send = vi.fn(
      () =>
        new Promise<NotifyActionResult>((resolve) => {
          resolvers.push(resolve)
        }),
    )

    const batcher = new SafePathBatcher({
      batchWindowMs: 200,
      sendNotification: send as SafePathBatcher["sendNotification"],
      countdownMs: 5_000,
      sound: false,
    })

    // First item: flushes after batch window
    const p1 = batcher.enqueue("port/*")
    vi.advanceTimersByTime(200)
    await vi.runAllTimersAsync()

    // Notification 1 is now in-flight
    expect(send).toHaveBeenCalledTimes(1)

    // Second item arrives while first notification is still active
    const p2 = batcher.enqueue("wc -l port/src/**")
    // Even after another batch window, no second notification should fire
    vi.advanceTimersByTime(200)
    await vi.runAllTimersAsync()

    // Still only one call — the second item is queued, not flushed
    expect(send).toHaveBeenCalledTimes(1)

    // Resolve the first notification; this should trigger flush for p2
    resolvers[0]!({ type: "timeout" })
    await vi.runAllTimersAsync()

    // Now the second item should have triggered a second notification
    expect(send).toHaveBeenCalledTimes(2)
    expect(await p1).toBe("allow")

    // Resolve the second notification
    resolvers[1]!({ type: "timeout" })
    await vi.runAllTimersAsync()
    expect(await p2).toBe("allow")
  })

  it("accumulates items that arrive during an active notification into a single follow-up notification", async () => {
    vi.useFakeTimers()

    const resolvers: Array<(r: NotifyActionResult) => void> = []
    const send = vi.fn(
      () =>
        new Promise<NotifyActionResult>((resolve) => {
          resolvers.push(resolve)
        }),
    )

    const batcher = new SafePathBatcher({
      batchWindowMs: 200,
      sendNotification: send as SafePathBatcher["sendNotification"],
      countdownMs: 5_000,
      sound: false,
    })

    // First flush
    batcher.enqueue("item-1")
    vi.advanceTimersByTime(200)
    await vi.runAllTimersAsync()
    expect(send).toHaveBeenCalledTimes(1)

    // Three more items arrive while notification 1 is in-flight
    const p2 = batcher.enqueue("item-2")
    const p3 = batcher.enqueue("item-3")
    const p4 = batcher.enqueue("item-4")

    // Resolve notification 1 — should trigger one combined notification for 2+3+4
    resolvers[0]!({ type: "timeout" })
    await vi.runAllTimersAsync()

    // All three queued items should fire in ONE combined notification (#2)
    expect(send).toHaveBeenCalledTimes(2)
    const secondCallArgs = (send.mock.calls as unknown as NotifyArgs[][])[1]?.[0]
    expect(secondCallArgs?.message).toMatch(/\(\+2 more\)/)

    // Resolve notification 2
    resolvers[1]!({ type: "timeout" })
    await vi.runAllTimersAsync()
    expect(await p2).toBe("allow")
    expect(await p3).toBe("allow")
    expect(await p4).toBe("allow")
  })

  it("items queued during a cancelled notification still get their own follow-up", async () => {
    vi.useFakeTimers()

    const send = vi.fn()
    let resolveFirst!: (r: NotifyActionResult) => void
    send.mockImplementationOnce(
      () =>
        new Promise<NotifyActionResult>((resolve) => {
          resolveFirst = resolve
        }),
    )
    send.mockResolvedValue({ type: "timeout" } as NotifyActionResult)

    const batcher = new SafePathBatcher({
      batchWindowMs: 200,
      sendNotification: send as SafePathBatcher["sendNotification"],
      countdownMs: 5_000,
      sound: false,
    })

    batcher.enqueue("item-1")
    vi.advanceTimersByTime(200)
    await vi.runAllTimersAsync()
    expect(send).toHaveBeenCalledTimes(1)

    const p2 = batcher.enqueue("item-2")

    // Notification 1 is cancelled
    resolveFirst({ type: "cancel" })
    await vi.runAllTimersAsync()

    // item-2 still gets its own notification
    expect(send).toHaveBeenCalledTimes(2)
    expect(await p2).toBe("allow") // timeout on follow-up
  })
})
