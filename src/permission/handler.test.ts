import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../classifier/classify.ts", () => ({
  classifyCommand: vi.fn(),
}))
// Only `getSessionMessages` is mocked (it's the only I/O call the handler
// performs against the messages module). The pure extractors
// (extractLastUserMessages / extractLatestAssistantModel) run unmocked so
// tests exercise the same code path as production.
vi.mock("../ui/messages.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getSessionMessages: vi.fn(),
  }
})
vi.mock("./safe-path.ts", () => ({
  runSafePath: vi.fn(),
}))
vi.mock("./risky-path.ts", () => ({
  runRiskyPathInBackground: vi.fn(),
}))

import { classifyCommand } from "../classifier/classify.ts"
import { getSessionMessages, type MessageEntry } from "../ui/messages.ts"
import { runSafePath } from "./safe-path.ts"
import { runRiskyPathInBackground } from "./risky-path.ts"
import { handlePermissionEvent } from "./handler.ts"
import { DEFAULT_CONFIG } from "../config.ts"

const mockedClassify = vi.mocked(classifyCommand)
const mockedGetSessionMessages = vi.mocked(getSessionMessages)
const mockedSafe = vi.mocked(runSafePath)
const mockedRisky = vi.mocked(runRiskyPathInBackground)

/** Minimal synthetic entry helpers for handler tests. */
function userEntry(text: string): MessageEntry {
  return {
    info: {
      id: `u_${text}`,
      sessionID: "sess_test",
      role: "user",
      time: { created: 0 },
    } as MessageEntry["info"],
    parts: [
      {
        id: `p_${text}`,
        sessionID: "sess_test",
        messageID: `u_${text}`,
        type: "text",
        text,
      } as MessageEntry["parts"][number],
    ],
  }
}

function assistantEntryWithModel(
  providerID: string,
  modelID: string,
): MessageEntry {
  return {
    info: {
      id: `a_${modelID}`,
      sessionID: "sess_test",
      role: "assistant",
      time: { created: 0 },
      providerID,
      modelID,
    } as unknown as MessageEntry["info"],
    parts: [],
  }
}

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
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
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
    log,
  }
  return { ctx, respondCall, log }
}

beforeEach(() => {
  mockedClassify.mockReset()
  mockedGetSessionMessages.mockReset()
  mockedSafe.mockReset()
  mockedRisky.mockReset()
  // Default: one user message, no assistant messages. Tests that need
  // assistant-model fallback override this with their own value.
  mockedGetSessionMessages.mockResolvedValue([
    userEntry("please check the repo"),
  ])
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

  it("does nothing when getSessionMessages throws", async () => {
    mockedGetSessionMessages.mockRejectedValueOnce(new Error("sdk explode"))

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

  it("applies config.contextMessageCount when extracting user messages", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    // 5 user messages available; contextMessageCount=2 → classifier sees
    // only the last 2.
    mockedGetSessionMessages.mockResolvedValueOnce([
      userEntry("m1"),
      userEntry("m2"),
      userEntry("m3"),
      userEntry("m4"),
      userEntry("m5"),
    ])

    const { ctx } = buildCtx({ contextMessageCount: 2 })
    await handlePermissionEvent(basePermission(), ctx)

    const classifyArgs = mockedClassify.mock.calls[0]?.[0]
    expect(classifyArgs?.userMessages).toEqual(["m4", "m5"])
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

  // --- runtime-shape adapter --------------------------------------------
  //
  // The opencode 1.4.x event stream emits permissions with field names
  // `permission` (tool type) and `patterns` (string[]), different from the
  // SDK-typed Permission's `type` / `pattern`. The handler must accept
  // both.

  it("accepts runtime-shape permission ({ permission, patterns })", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    const { ctx, respondCall } = buildCtx()
    // Shape as opencode actually emits on 1.4.x: `permission` (not `type`)
    // and `patterns` (array, not `pattern`).
    const runtime = {
      id: "per_runtime",
      permission: "bash",
      patterns: ["uname -a"],
      sessionID: "sess_rt",
      messageID: "msg_rt",
      title: "Run bash command",
      metadata: {},
      time: { created: 0 },
    } as never

    await handlePermissionEvent(runtime, ctx)

    expect(mockedClassify).toHaveBeenCalledTimes(1)
    const classifyArgs = mockedClassify.mock.calls[0]?.[0]
    expect(classifyArgs?.command).toBe("uname -a")
    expect(respondCall).toHaveBeenCalledTimes(1)
  })

  it("skips runtime-shape permission with a non-bash `permission` value", async () => {
    const { ctx, respondCall } = buildCtx()
    const runtime = {
      id: "per_runtime_task",
      permission: "task",
      patterns: ["committer"],
      sessionID: "sess_rt",
      messageID: "msg_rt",
      title: "Launch subagent",
      metadata: {},
      time: { created: 0 },
    } as never

    await handlePermissionEvent(runtime, ctx)

    expect(mockedClassify).not.toHaveBeenCalled()
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("skips runtime-shape permission when `patterns` is empty", async () => {
    const { ctx, respondCall } = buildCtx()
    const runtime = {
      id: "per_runtime_empty",
      permission: "bash",
      patterns: [],
      sessionID: "sess_rt",
      messageID: "msg_rt",
      title: "Run bash command",
      metadata: {},
      time: { created: 0 },
    } as never

    await handlePermissionEvent(runtime, ctx)

    expect(mockedClassify).not.toHaveBeenCalled()
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("prefers runtime-shape fields over SDK-typed fields when both present", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    const { ctx } = buildCtx()
    // Hybrid input: both shapes present. Runtime names should win.
    const hybrid = {
      id: "per_hybrid",
      type: "task", // SDK-typed: would be skipped as non-bash
      pattern: "wrong command", // SDK-typed
      permission: "bash", // runtime: should win, passes bash check
      patterns: ["ls -la"], // runtime: should win, extract this command
      sessionID: "sess_rt",
      messageID: "msg_rt",
      title: "Run bash command",
      metadata: {},
      time: { created: 0 },
    } as never

    await handlePermissionEvent(hybrid, ctx)

    expect(mockedClassify).toHaveBeenCalledTimes(1)
    const classifyArgs = mockedClassify.mock.calls[0]?.[0]
    expect(classifyArgs?.command).toBe("ls -la")
  })

  // --- session-model fallback from latest assistant message -------------
  //
  // When the `config` hook hasn't surfaced `ctx.sessionModel` (e.g. the
  // hook didn't fire, or opencode's runtime Config uses different field
  // names), the handler falls back to the latest assistant message's
  // model in the session's message stream.

  it("uses assistant-message model fallback when ctx.sessionModel is undefined", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    // Message stream contains an assistant with a model; ctx.sessionModel
    // is undefined; no classifier override.
    mockedGetSessionMessages.mockResolvedValueOnce([
      userEntry("help me out"),
      assistantEntryWithModel("openai", "gpt-5-codex"),
      userEntry("thanks"),
    ])

    const { ctx } = buildCtx({ sessionModel: undefined })
    await handlePermissionEvent(basePermission(), ctx)

    expect(mockedClassify).toHaveBeenCalledTimes(1)
    const classifyArgs = mockedClassify.mock.calls[0]?.[0]
    // openai has a provider default (gpt-4.1-mini), which the resolver
    // prefers over the fallback's raw modelID.
    expect(classifyArgs?.model.providerID).toBe("openai")
  })

  it("still skips with 'no classifier model' when every source fails", async () => {
    // No ctx.sessionModel, no config override, message stream has no
    // assistant with a model → resolver returns null → handler skips.
    mockedGetSessionMessages.mockResolvedValueOnce([userEntry("just me")])
    const { ctx, respondCall } = buildCtx({ sessionModel: undefined })

    await handlePermissionEvent(basePermission(), ctx)

    expect(mockedClassify).not.toHaveBeenCalled()
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("ctx.sessionModel takes precedence over the assistant-message fallback", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    // Assistant in stream says openai/gpt-5, but ctx.sessionModel says
    // anthropic/claude-sonnet. The explicit ctx value wins.
    mockedGetSessionMessages.mockResolvedValueOnce([
      userEntry("hi"),
      assistantEntryWithModel("openai", "gpt-5"),
    ])

    const { ctx } = buildCtx({
      sessionModel: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    })
    await handlePermissionEvent(basePermission(), ctx)

    const classifyArgs = mockedClassify.mock.calls[0]?.[0]
    expect(classifyArgs?.model.providerID).toBe("anthropic")
  })

  it("config classifierModel override takes precedence over both session and fallback", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    mockedGetSessionMessages.mockResolvedValueOnce([
      userEntry("hi"),
      assistantEntryWithModel("openai", "gpt-5"),
    ])

    const { ctx } = buildCtx({
      classifierModel: "anthropic/claude-haiku-4-5",
      sessionModel: { providerID: "openai", modelID: "gpt-4o" },
    })
    await handlePermissionEvent(basePermission(), ctx)

    const classifyArgs = mockedClassify.mock.calls[0]?.[0]
    expect(classifyArgs?.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    })
  })
})
