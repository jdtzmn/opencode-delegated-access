import { describe, it, expect, vi } from "vitest"
import {
  FailureNotifyRateLimiter,
  runFailureNotificationInBackground,
} from "./failure-notify.ts"
import type { NotifyActionResult } from "../notify/notify.ts"

describe("FailureNotifyRateLimiter", () => {
  it("allows the first failure", () => {
    const rl = new FailureNotifyRateLimiter({ cooldownMs: 1000 })
    const d = rl.register("timeout", 0)
    expect(d.notify).toBe(true)
    expect(d.suppressedCount).toBe(0)
  })

  it("suppresses a second failure within the cooldown window", () => {
    const rl = new FailureNotifyRateLimiter({ cooldownMs: 1000 })
    rl.register("timeout", 0)
    const d = rl.register("timeout", 500)
    expect(d.notify).toBe(false)
  })

  it("allows again once the cooldown has elapsed", () => {
    const rl = new FailureNotifyRateLimiter({ cooldownMs: 1000 })
    rl.register("timeout", 0)
    rl.register("timeout", 500) // suppressed
    const d = rl.register("timeout", 1001)
    expect(d.notify).toBe(true)
  })

  it("reports how many failures were suppressed since the last allowed notify (burst collapse)", () => {
    const rl = new FailureNotifyRateLimiter({ cooldownMs: 1000 })
    rl.register("timeout", 0) // allowed
    rl.register("timeout", 100) // suppressed (1)
    rl.register("timeout", 200) // suppressed (2)
    rl.register("error", 300) // suppressed (3)
    const d = rl.register("timeout", 1001) // allowed again
    expect(d.notify).toBe(true)
    expect(d.suppressedCount).toBe(3)
  })

  it("disables the rate limit entirely when cooldownMs is 0", () => {
    const rl = new FailureNotifyRateLimiter({ cooldownMs: 0 })
    expect(rl.register("timeout", 0).notify).toBe(true)
    expect(rl.register("timeout", 0).notify).toBe(true)
    expect(rl.register("timeout", 1).notify).toBe(true)
  })
})

/** Build a client that records the permission-respond call. */
function mockClient() {
  const respond = vi.fn(
    async (_opts: {
      path: { id: string; permissionID: string }
      body: { response: string }
    }) => ({ data: true }),
  )
  return {
    client: {
      postSessionIdPermissionsPermissionId: respond,
    } as never,
    respond,
  }
}

const baseArgs = {
  sessionID: "sess_1",
  permissionID: "perm_1",
  command: "whoami && date",
  failureClass: "timeout" as const,
  suppressedCount: 0,
  sound: false,
  timeoutSec: 30,
}

describe("runFailureNotificationInBackground", () => {
  it("sends a notification with a Reject action but NO Approve action", async () => {
    const sent: Parameters<typeof import("../notify/notify.ts").sendNotification>[0][] =
      []
    const sendNotification = vi.fn(async (a: { actions?: string[] }) => {
      sent.push(a as never)
      return { type: "timeout" } as NotifyActionResult
    })
    const { client } = mockClient()

    await runFailureNotificationInBackground({
      ...baseArgs,
      client,
      sendNotification: sendNotification as never,
    })

    expect(sendNotification).toHaveBeenCalledTimes(1)
    const actions = sent[0]?.actions ?? []
    expect(actions).toContain("Reject")
    expect(actions).not.toContain("Approve")
  })

  it("resolves the permission as 'reject' when the user clicks Reject", async () => {
    const sendNotification = vi.fn(
      async () => ({ type: "action", label: "Reject" }) as NotifyActionResult,
    )
    const { client, respond } = mockClient()

    await runFailureNotificationInBackground({
      ...baseArgs,
      client,
      sendNotification: sendNotification as never,
    })

    expect(respond).toHaveBeenCalledTimes(1)
    const call = respond.mock.calls[0]?.[0]
    expect(call?.body.response).toBe("reject")
    expect(call?.path.permissionID).toBe("perm_1")
  })

  it("does NOT resolve the permission on timeout/cancel/click (TUI prompt stays)", async () => {
    const { client, respond } = mockClient()
    for (const result of [
      { type: "timeout" },
      { type: "cancel" },
      { type: "click" },
    ] as NotifyActionResult[]) {
      const sendNotification = vi.fn(async () => result)
      await runFailureNotificationInBackground({
        ...baseArgs,
        client,
        sendNotification: sendNotification as never,
      })
    }
    expect(respond).not.toHaveBeenCalled()
  })

  it("mentions the failure class in the notification title", async () => {
    const titles: string[] = []
    const sendNotification = vi.fn(async (a: { title: string }) => {
      titles.push(a.title)
      return { type: "timeout" } as NotifyActionResult
    })
    const { client } = mockClient()

    await runFailureNotificationInBackground({
      ...baseArgs,
      failureClass: "timeout",
      client,
      sendNotification: sendNotification as never,
    })

    expect(titles[0]?.toLowerCase()).toMatch(/timed out|timeout/)
  })

  it("mentions a collapsed burst count when suppressedCount > 0", async () => {
    const messages: string[] = []
    const sendNotification = vi.fn(async (a: { message: string }) => {
      messages.push(a.message)
      return { type: "timeout" } as NotifyActionResult
    })
    const { client } = mockClient()

    await runFailureNotificationInBackground({
      ...baseArgs,
      suppressedCount: 3,
      client,
      sendNotification: sendNotification as never,
    })

    // 3 suppressed + this one = 4 total failures referenced.
    expect(messages[0]).toMatch(/4|3 more|\+3/)
  })

  it("swallows SDK errors (TUI prompt remains as fallback)", async () => {
    const respond = vi.fn(async () => {
      throw new Error("sdk boom")
    })
    const client = {
      postSessionIdPermissionsPermissionId: respond,
    } as never
    const sendNotification = vi.fn(
      async () => ({ type: "action", label: "Reject" }) as NotifyActionResult,
    )

    await expect(
      runFailureNotificationInBackground({
        ...baseArgs,
        client,
        sendNotification: sendNotification as never,
      }),
    ).resolves.toBeUndefined()
  })
})
