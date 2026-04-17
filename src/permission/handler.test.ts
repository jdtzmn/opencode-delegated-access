import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../classifier/classify.ts", () => ({
  classifyCommand: vi.fn(),
}))
vi.mock("../ui/messages.ts", () => ({
  getLastUserMessages: vi.fn(),
}))
vi.mock("./safe-path.ts", () => ({
  runSafePath: vi.fn(),
}))
vi.mock("./risky-path.ts", () => ({
  runRiskyPathInBackground: vi.fn(),
}))

import { classifyCommand } from "../classifier/classify.ts"
import { getLastUserMessages } from "../ui/messages.ts"
import { runSafePath } from "./safe-path.ts"
import { runRiskyPathInBackground } from "./risky-path.ts"
import { handlePermissionEvent } from "./handler.ts"
import { DEFAULT_CONFIG } from "../config.ts"

const mockedClassify = vi.mocked(classifyCommand)
const mockedGetMsgs = vi.mocked(getLastUserMessages)
const mockedSafe = vi.mocked(runSafePath)
const mockedRisky = vi.mocked(runRiskyPathInBackground)

/**
 * Build a ctx whose client records calls to the permission-respond endpoint.
 * Returns both the ctx and the recorded calls so tests can assert on them.
 */
function buildCtx(overrides: Partial<{
  enabled: boolean
  contextMessageCount: number
  classifierModel: string
  sessionModel: { providerID: string; modelID: string } | undefined
  respondImpl: (opts: unknown) => Promise<unknown>
}> = {}) {
  const respondCall = vi.fn(
    overrides.respondImpl ?? (async () => ({ data: true } as unknown)),
  )
  const ctx = {
    client: {
      postSessionIdPermissionsPermissionId: respondCall,
    } as never,
    config: {
      ...DEFAULT_CONFIG,
      ...(overrides.enabled !== undefined ? { enabled: overrides.enabled } : {}),
      ...(overrides.contextMessageCount !== undefined
        ? { contextMessageCount: overrides.contextMessageCount }
        : {}),
      ...(overrides.classifierModel !== undefined
        ? { classifierModel: overrides.classifierModel }
        : {}),
    },
    sessionModel:
      "sessionModel" in overrides
        ? overrides.sessionModel
        : { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    ephemeralSessionIDs: new Set<string>(),
  }
  return { ctx, respondCall }
}

beforeEach(() => {
  mockedClassify.mockReset()
  mockedGetMsgs.mockReset()
  mockedSafe.mockReset()
  mockedRisky.mockReset()
  mockedGetMsgs.mockResolvedValue(["please check the repo"])
})

function basePermission(overrides: Record<string, unknown> = {}) {
  return {
    id: "perm_123",
    type: "bash",
    pattern: "git status",
    sessionID: "sess_abc",
    messageID: "msg_xyz",
    title: "Run bash command",
    metadata: {},
    time: { created: 0 },
    ...overrides,
  } as never
}

describe("handlePermissionEvent", () => {
  it("does nothing when config.enabled is false", async () => {
    const { ctx, respondCall } = buildCtx({ enabled: false })
    await handlePermissionEvent(basePermission(), ctx)
    expect(mockedClassify).not.toHaveBeenCalled()
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("does nothing for non-bash tool types", async () => {
    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(basePermission({ type: "edit" }), ctx)
    expect(mockedClassify).not.toHaveBeenCalled()
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("calls the SDK with response='once' when SAFE and safe-path returns allow", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "SAFE",
      reason: "read-only",
    })
    mockedSafe.mockResolvedValueOnce("allow")

    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(basePermission(), ctx)

    expect(respondCall).toHaveBeenCalledTimes(1)
    const args = respondCall.mock.calls[0]?.[0] as {
      path: { id: string; permissionID: string }
      body: { response: string }
    }
    expect(args.path).toEqual({ id: "sess_abc", permissionID: "perm_123" })
    expect(args.body.response).toBe("once")
    expect(mockedRisky).not.toHaveBeenCalled()
  })

  it("does NOT call the SDK when SAFE but user cancels (safe-path returns ask)", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "SAFE",
      reason: "read-only",
    })
    mockedSafe.mockResolvedValueOnce("ask")

    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(basePermission(), ctx)

    expect(respondCall).not.toHaveBeenCalled()
  })

  it("starts the risky-path in background when verdict is RISKY", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "RISKY",
      reason: "destructive",
    })
    mockedRisky.mockResolvedValue(undefined)

    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(
      basePermission({ pattern: "rm -rf /" }),
      ctx,
    )

    // We don't call the SDK directly in the RISKY path; the risky-path
    // function calls it on button click.
    expect(respondCall).not.toHaveBeenCalled()
    expect(mockedRisky).toHaveBeenCalledTimes(1)
    const args = mockedRisky.mock.calls[0]?.[0]
    expect(args?.sessionID).toBe("sess_abc")
    expect(args?.permissionID).toBe("perm_123")
    expect(args?.command).toBe("rm -rf /")
    expect(args?.reason).toBe("destructive")
  })

  it("does nothing when the classifier fails (returns null)", async () => {
    mockedClassify.mockResolvedValueOnce(null)

    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(basePermission(), ctx)

    expect(respondCall).not.toHaveBeenCalled()
    expect(mockedSafe).not.toHaveBeenCalled()
    expect(mockedRisky).not.toHaveBeenCalled()
  })

  it("does nothing when getLastUserMessages throws", async () => {
    mockedGetMsgs.mockRejectedValueOnce(new Error("sdk explode"))

    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(basePermission(), ctx)

    expect(mockedClassify).not.toHaveBeenCalled()
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("extracts command from a string pattern", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "SAFE",
      reason: "r",
    })
    mockedSafe.mockResolvedValueOnce("allow")

    const { ctx } = buildCtx()
    await handlePermissionEvent(
      basePermission({ pattern: "echo hi" }),
      ctx,
    )

    const args = mockedClassify.mock.calls[0]?.[0]
    expect(args?.command).toBe("echo hi")
  })

  it("extracts command from an array pattern (first element)", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "SAFE",
      reason: "r",
    })
    mockedSafe.mockResolvedValueOnce("allow")

    const { ctx } = buildCtx()
    await handlePermissionEvent(
      basePermission({ pattern: ["ls -la", "/fallback"] }),
      ctx,
    )

    const args = mockedClassify.mock.calls[0]?.[0]
    expect(args?.command).toBe("ls -la")
  })

  it("does nothing when pattern is missing (no command to classify)", async () => {
    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(
      basePermission({ pattern: undefined }),
      ctx,
    )
    expect(mockedClassify).not.toHaveBeenCalled()
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("passes config.contextMessageCount to getLastUserMessages", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    const { ctx } = buildCtx({ contextMessageCount: 7 })
    await handlePermissionEvent(basePermission(), ctx)

    const callArgs = mockedGetMsgs.mock.calls[0]
    expect(callArgs?.[2]).toBe(7)
  })

  it("uses the resolved classifier model (config override wins)", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    const { ctx } = buildCtx({
      classifierModel: "anthropic/claude-haiku-4-5",
    })
    await handlePermissionEvent(basePermission(), ctx)

    const args = mockedClassify.mock.calls[0]?.[0]
    expect(args?.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    })
  })

  it("does nothing when no classifier model can be resolved", async () => {
    const { ctx, respondCall } = buildCtx({
      sessionModel: undefined,
      classifierModel: undefined as unknown as string,
    })
    await handlePermissionEvent(basePermission(), ctx)
    expect(mockedClassify).not.toHaveBeenCalled()
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("passes the loop-guard callbacks to classifyCommand", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    const { ctx } = buildCtx()
    await handlePermissionEvent(basePermission(), ctx)

    const args = mockedClassify.mock.calls[0]?.[0]
    expect(typeof args?.onEphemeralSessionCreated).toBe("function")
    expect(typeof args?.onEphemeralSessionDeleted).toBe("function")

    // Exercise the callbacks to confirm they update the tracking set.
    args?.onEphemeralSessionCreated?.("sess_eph_abc")
    expect(ctx.ephemeralSessionIDs.has("sess_eph_abc")).toBe(true)
    args?.onEphemeralSessionDeleted?.("sess_eph_abc")
    expect(ctx.ephemeralSessionIDs.has("sess_eph_abc")).toBe(false)
  })

  it("swallows SDK respond errors (TUI prompt remains as fallback)", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "SAFE",
      reason: "r",
    })
    mockedSafe.mockResolvedValueOnce("allow")

    const { ctx, respondCall } = buildCtx({
      respondImpl: async () => {
        throw new Error("sdk boom")
      },
    })

    // Should not throw.
    await expect(
      handlePermissionEvent(basePermission(), ctx),
    ).resolves.toBeUndefined()
    expect(respondCall).toHaveBeenCalledTimes(1)
  })

  // --- pre-ask interception path (permission.ask hook with output) -------

  it("when output is provided and verdict is SAFE-allow, sets output.status='allow' instead of calling SDK", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    const { ctx, respondCall } = buildCtx()
    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermissionEvent(basePermission(), ctx, {
      hookName: "permission.ask",
      output,
    })

    expect(output.status).toBe("allow")
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("when output is provided and verdict is SAFE but user cancels, leaves output.status='ask'", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("ask")

    const { ctx, respondCall } = buildCtx()
    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermissionEvent(basePermission(), ctx, {
      hookName: "permission.ask",
      output,
    })

    expect(output.status).toBe("ask")
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("when output is provided and verdict is RISKY, leaves output.status='ask' and kicks off risky path", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "RISKY",
      reason: "destructive",
    })
    mockedRisky.mockResolvedValue(undefined)

    const { ctx, respondCall } = buildCtx()
    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermissionEvent(
      basePermission({ pattern: "rm -rf /" }),
      ctx,
      { hookName: "permission.ask", output },
    )

    // TUI prompt should still be shown; notification runs alongside.
    expect(output.status).toBe("ask")
    expect(mockedRisky).toHaveBeenCalledTimes(1)
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("when output is provided and classifier fails, leaves output.status='ask' (fail closed)", async () => {
    mockedClassify.mockResolvedValueOnce(null)

    const { ctx, respondCall } = buildCtx()
    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermissionEvent(basePermission(), ctx, {
      hookName: "permission.ask",
      output,
    })

    expect(output.status).toBe("ask")
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("calls SDK when output is NOT provided (permission.updated / event paths)", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(basePermission(), ctx, {
      hookName: "permission.updated",
    })

    expect(respondCall).toHaveBeenCalledTimes(1)
  })
})
