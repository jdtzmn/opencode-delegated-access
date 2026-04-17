import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../notify/notify.ts", () => ({
  sendNotification: vi.fn(),
}))

import { sendNotification } from "../notify/notify.ts"
import type { NotifyActionResult } from "../notify/notify.ts"
import { runRiskyPathInBackground } from "./risky-path.ts"

const mockedSend = vi.mocked(sendNotification)

beforeEach(() => {
  mockedSend.mockReset()
})

function makeMockClient(responseImpl?: (opts: unknown) => Promise<unknown>) {
  const call = vi.fn(
    responseImpl ?? (async () => ({ data: true } as unknown)),
  )
  return {
    client: {
      postSessionIdPermissionsPermissionId: call,
    } as never,
    call,
  }
}

const baseArgs = {
  sessionID: "sess_main",
  permissionID: "perm_123",
  command: "rm -rf build",
  reason: "destructive rm",
  sound: true,
  timeoutSec: 60,
}

describe("runRiskyPathInBackground", () => {
  it("calls the SDK with response='once' when user clicks Approve", async () => {
    mockedSend.mockResolvedValueOnce({
      type: "action",
      label: "Approve",
    } as NotifyActionResult)
    const { client, call } = makeMockClient()

    await runRiskyPathInBackground({ ...baseArgs, client })

    expect(call).toHaveBeenCalledTimes(1)
    const arg = call.mock.calls[0]?.[0] as {
      path: { id: string; permissionID: string }
      body: { response: string }
    }
    expect(arg.path).toEqual({ id: "sess_main", permissionID: "perm_123" })
    expect(arg.body.response).toBe("once")
  })

  it("calls the SDK with response='reject' when user clicks Reject", async () => {
    mockedSend.mockResolvedValueOnce({
      type: "action",
      label: "Reject",
    } as NotifyActionResult)
    const { client, call } = makeMockClient()

    await runRiskyPathInBackground({ ...baseArgs, client })

    const arg = call.mock.calls[0]?.[0] as {
      body: { response: string }
    }
    expect(arg.body.response).toBe("reject")
  })

  it("does NOT call the SDK when the notification times out (user will decide in TUI)", async () => {
    mockedSend.mockResolvedValueOnce({ type: "timeout" } as NotifyActionResult)
    const { client, call } = makeMockClient()

    await runRiskyPathInBackground({ ...baseArgs, client })
    expect(call).not.toHaveBeenCalled()
  })

  it("does NOT call the SDK when the user dismisses the notification", async () => {
    mockedSend.mockResolvedValueOnce({ type: "cancel" } as NotifyActionResult)
    const { client, call } = makeMockClient()

    await runRiskyPathInBackground({ ...baseArgs, client })
    expect(call).not.toHaveBeenCalled()
  })

  it("does NOT call the SDK when the user clicks the notification body", async () => {
    mockedSend.mockResolvedValueOnce({ type: "click" } as NotifyActionResult)
    const { client, call } = makeMockClient()

    await runRiskyPathInBackground({ ...baseArgs, client })
    expect(call).not.toHaveBeenCalled()
  })

  it("does NOT call the SDK when the notifier errors (TUI is still available)", async () => {
    mockedSend.mockResolvedValueOnce({
      type: "error",
      error: new Error("no display"),
    } as NotifyActionResult)
    const { client, call } = makeMockClient()

    await runRiskyPathInBackground({ ...baseArgs, client })
    expect(call).not.toHaveBeenCalled()
  })

  it("does NOT throw if the SDK call itself errors (TUI is still there to fall back on)", async () => {
    mockedSend.mockResolvedValueOnce({
      type: "action",
      label: "Approve",
    } as NotifyActionResult)
    const { client } = makeMockClient(async () => {
      throw new Error("sdk boom")
    })

    await expect(
      runRiskyPathInBackground({ ...baseArgs, client }),
    ).resolves.toBeUndefined()
  })

  it("does NOT throw on unexpected action label — just leaves it for the TUI", async () => {
    mockedSend.mockResolvedValueOnce({
      type: "action",
      label: "Snooze",
    } as NotifyActionResult)
    const { client, call } = makeMockClient()

    await runRiskyPathInBackground({ ...baseArgs, client })
    // No SDK call for unknown actions; TUI prompt remains live.
    expect(call).not.toHaveBeenCalled()
  })

  it("passes Approve + Reject as action buttons, command + reason as context", async () => {
    mockedSend.mockResolvedValueOnce({ type: "timeout" } as NotifyActionResult)
    const { client } = makeMockClient()

    await runRiskyPathInBackground({ ...baseArgs, client })

    const args = mockedSend.mock.calls[0]?.[0]
    expect(args?.actions).toEqual(["Approve", "Reject"])
    expect(args?.message).toContain("rm -rf build")
    expect(args?.sound).toBe(true)
    expect(args?.timeoutSec).toBe(60)
    expect(args?.title.toLowerCase()).toMatch(/risky|review/)
  })

  it("truncates excessively long commands in the notification body", async () => {
    mockedSend.mockResolvedValueOnce({ type: "timeout" } as NotifyActionResult)
    const { client } = makeMockClient()

    const longCmd = "curl " + "x".repeat(500)
    await runRiskyPathInBackground({
      ...baseArgs,
      command: longCmd,
      client,
    })

    const args = mockedSend.mock.calls[0]?.[0]
    expect(args?.message.length).toBeLessThan(400)
  })
})
