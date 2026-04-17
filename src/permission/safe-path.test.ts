import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the notify wrapper so we can inject outcomes directly.
vi.mock("../notify/notify.ts", () => ({
  sendNotification: vi.fn(),
}))

import { sendNotification } from "../notify/notify.ts"
import { runSafePath } from "./safe-path.ts"
import type { NotifyActionResult } from "../notify/notify.ts"

const mockedSend = vi.mocked(sendNotification)

beforeEach(() => {
  mockedSend.mockReset()
})

describe("runSafePath", () => {
  it("returns 'allow' when countdownMs is 0 (silent auto-approve, no notification)", async () => {
    const result = await runSafePath({
      command: "ls",
      reason: "read-only",
      countdownMs: 0,
      sound: true,
    })
    expect(result).toBe("allow")
    expect(mockedSend).not.toHaveBeenCalled()
  })

  it("returns 'allow' when the notification times out (user did not cancel)", async () => {
    mockedSend.mockResolvedValueOnce({ type: "timeout" } as NotifyActionResult)

    const result = await runSafePath({
      command: "git status",
      reason: "read-only",
      countdownMs: 5_000,
      sound: true,
    })
    expect(result).toBe("allow")
  })

  it("returns 'ask' when user clicks the Cancel action button", async () => {
    mockedSend.mockResolvedValueOnce({
      type: "action",
      label: "Cancel",
    } as NotifyActionResult)

    const result = await runSafePath({
      command: "ls",
      reason: "read-only",
      countdownMs: 5_000,
      sound: true,
    })
    expect(result).toBe("ask")
  })

  it("returns 'ask' when the user dismisses the notification", async () => {
    mockedSend.mockResolvedValueOnce({ type: "cancel" } as NotifyActionResult)

    const result = await runSafePath({
      command: "ls",
      reason: "read-only",
      countdownMs: 5_000,
      sound: true,
    })
    expect(result).toBe("ask")
  })

  it("returns 'ask' when the user clicks the notification body (treated as 'I want to review')", async () => {
    mockedSend.mockResolvedValueOnce({ type: "click" } as NotifyActionResult)

    const result = await runSafePath({
      command: "ls",
      reason: "read-only",
      countdownMs: 5_000,
      sound: true,
    })
    expect(result).toBe("ask")
  })

  it("returns 'allow' (fail-open on notifier error to preserve the SAFE classification)", async () => {
    mockedSend.mockResolvedValueOnce({
      type: "error",
      error: new Error("no display"),
    } as NotifyActionResult)

    const result = await runSafePath({
      command: "ls",
      reason: "read-only",
      countdownMs: 5_000,
      sound: true,
    })
    // A platform-level notifier failure shouldn't block an already-classified
    // SAFE command. The classifier already said this is fine; the notification
    // is a nicety, not a second gate.
    expect(result).toBe("allow")
  })

  it("passes command, reason, and countdown into the notification", async () => {
    mockedSend.mockResolvedValueOnce({ type: "timeout" } as NotifyActionResult)

    await runSafePath({
      command: "npm test",
      reason: "routine test run",
      countdownMs: 4_000,
      sound: false,
    })

    const args = mockedSend.mock.calls[0]?.[0]
    expect(args?.title).toMatch(/delegated.?access|running|auto/i)
    expect(args?.message).toContain("npm test")
    expect(args?.sound).toBe(false)
    expect(args?.timeoutSec).toBe(4)
    // Cancel action is the only explicit action in SAFE path.
    expect(args?.actions).toEqual(["Cancel"])
  })

  it("rounds up countdownMs to at least 1 second for the notification timeout", async () => {
    mockedSend.mockResolvedValueOnce({ type: "timeout" } as NotifyActionResult)

    await runSafePath({
      command: "ls",
      reason: "r",
      countdownMs: 400,
      sound: true,
    })
    const args = mockedSend.mock.calls[0]?.[0]
    expect(args?.timeoutSec).toBe(1)
  })

  it("truncates long commands in the notification body", async () => {
    mockedSend.mockResolvedValueOnce({ type: "timeout" } as NotifyActionResult)

    const longCmd = "echo " + "x".repeat(500)
    await runSafePath({
      command: longCmd,
      reason: "r",
      countdownMs: 3_000,
      sound: true,
    })
    const args = mockedSend.mock.calls[0]?.[0]
    // Body should include some form of the command but be bounded in length.
    expect(args?.message.length).toBeLessThan(300)
  })
})
