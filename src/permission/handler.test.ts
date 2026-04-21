import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../classifier/classify.ts", () => ({
  classifyCommand: vi.fn(),
  classifySubject: vi.fn(),
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
// `resolveRootSessionID` walks the session parent chain via the SDK; mock
// it so handler tests control what "root" sessionID the handler sees
// without having to stub session.get on the client object.
vi.mock("../ui/session-tree.ts", () => ({
  resolveRootSessionID: vi.fn(),
}))
vi.mock("./safe-path.ts", () => ({
  runSafePath: vi.fn(),
}))
vi.mock("./risky-path.ts", () => ({
  runRiskyPathInBackground: vi.fn(),
}))

import { classifyCommand, classifySubject } from "../classifier/classify.ts"
import { getSessionMessages, type MessageEntry } from "../ui/messages.ts"
import { resolveRootSessionID } from "../ui/session-tree.ts"
import { runSafePath } from "./safe-path.ts"
import { runRiskyPathInBackground } from "./risky-path.ts"
import { handlePermissionEvent } from "./handler.ts"
import { DirectoryVerdictCache } from "./directory-cache.ts"
import { SafePathBatcher } from "./safe-path-batcher.ts"
import { DEFAULT_CONFIG } from "../config.ts"

const mockedClassify = vi.mocked(classifyCommand)
const mockedClassifySubject = vi.mocked(classifySubject)
const mockedGetSessionMessages = vi.mocked(getSessionMessages)
const mockedResolveRoot = vi.mocked(resolveRootSessionID)
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
    directoryVerdictCache: new DirectoryVerdictCache(),
    safePathBatcher: new SafePathBatcher({
      batchWindowMs: 0, // flush immediately in tests (runSafePath is mocked anyway)
      sendNotification: async () => ({ type: "timeout" as const }),
      countdownMs: DEFAULT_CONFIG.safeCountdownMs,
      sound: false,
    }),
    log,
  }
  return { ctx, respondCall, log }
}

beforeEach(() => {
  mockedClassify.mockReset()
  mockedClassifySubject.mockReset()
  mockedGetSessionMessages.mockReset()
  mockedResolveRoot.mockReset()
  mockedSafe.mockReset()
  mockedRisky.mockReset()
  // Default: one user message, no assistant messages. Tests that need
  // assistant-model fallback override this with their own value.
  mockedGetSessionMessages.mockResolvedValue([
    userEntry("please check the repo"),
  ])
  // Default: treat the permission's own sessionID as the root (i.e. not
  // a subagent). Subagent tests override this to return a different
  // sessionID. Fail-closed tests override it to return null.
  mockedResolveRoot.mockImplementation(async (_client, sessionID) => sessionID)
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

  // --- subagent handling ------------------------------------------------
  //
  // When a bash permission fires inside a subagent session, the handler
  // must resolve the session's root (via resolveRootSessionID) and fetch
  // user messages from THERE, not from the subagent session — whose
  // "user" role entries are actually the dispatching agent's prompts.
  // Any failure to resolve a root is fail-closed: the handler skips
  // classification and leaves the TUI prompt alone for the user.

  it("fetches messages from the ROOT session when permission fires in a subagent", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    // Simulate: permission arrives with the subagent's sessionID; resolver
    // walks up and returns the root sessionID.
    mockedResolveRoot.mockImplementationOnce(async () => "sess_root")

    const { ctx } = buildCtx()
    await handlePermissionEvent(
      basePermission({ sessionID: "sess_subagent" }),
      ctx,
    )

    expect(mockedResolveRoot).toHaveBeenCalledTimes(1)
    expect(mockedResolveRoot.mock.calls[0]?.[1]).toBe("sess_subagent")

    // Messages must come from the ROOT session, not the subagent.
    expect(mockedGetSessionMessages).toHaveBeenCalledTimes(1)
    expect(mockedGetSessionMessages.mock.calls[0]?.[1]).toBe("sess_root")
  })

  it("fetches messages from the permission's own sessionID for a root session", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    // Default beforeEach behaviour: resolver returns the input sessionID
    // unchanged (i.e. already a root). No override needed.

    const { ctx } = buildCtx()
    await handlePermissionEvent(
      basePermission({ sessionID: "sess_root_only" }),
      ctx,
    )

    expect(mockedGetSessionMessages).toHaveBeenCalledTimes(1)
    expect(mockedGetSessionMessages.mock.calls[0]?.[1]).toBe("sess_root_only")
  })

  it("skips classification and does not call getSessionMessages when resolver returns null", async () => {
    // Resolver fail-closed: subagent's chain couldn't be verified.
    mockedResolveRoot.mockImplementationOnce(async () => null)

    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(
      basePermission({ sessionID: "sess_subagent" }),
      ctx,
    )

    // No message fetch, no classification, no response.
    expect(mockedGetSessionMessages).not.toHaveBeenCalled()
    expect(mockedClassify).not.toHaveBeenCalled()
    expect(mockedSafe).not.toHaveBeenCalled()
    expect(mockedRisky).not.toHaveBeenCalled()
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("keeps the permission's ORIGINAL sessionID as the classifier's parentSessionID", async () => {
    // Even when the resolver discovers a different root, the ephemeral
    // classifier session should be parented at the permission's session
    // (the subagent's), so the ephemeralSessionIDs loop-guard keeps
    // working and cleanup happens under the originating branch.
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")
    mockedResolveRoot.mockImplementationOnce(async () => "sess_root")

    const { ctx } = buildCtx()
    await handlePermissionEvent(
      basePermission({ sessionID: "sess_subagent" }),
      ctx,
    )

    const classifyArgs = mockedClassify.mock.calls[0]?.[0]
    expect(classifyArgs?.parentSessionID).toBe("sess_subagent")
  })

  it("classifier sees the ROOT session's user messages, not the subagent's", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")
    mockedResolveRoot.mockImplementationOnce(async () => "sess_root")

    // Tell getSessionMessages to return DIFFERENT message sets depending
    // on which sessionID is requested. The handler should request
    // `sess_root` (the resolved root), so the classifier must see the
    // root's human messages — not the subagent's dispatch prompt.
    mockedGetSessionMessages.mockImplementation(async (_client, id) => {
      if (id === "sess_root") return [userEntry("the real human said this")]
      return [userEntry("dispatching agent's prompt to subagent")]
    })

    const { ctx } = buildCtx()
    await handlePermissionEvent(
      basePermission({ sessionID: "sess_subagent" }),
      ctx,
    )

    const classifyArgs = mockedClassify.mock.calls[0]?.[0]
    expect(classifyArgs?.userMessages).toEqual(["the real human said this"])
  })

  // --- root-agent filter -----------------------------------------------
  //
  // Defense-in-depth: even from the resolved root session, only user
  // messages whose `info.agent` matches the root's primary agent should
  // flow to the classifier. This catches any "user" role entries that
  // might actually be synthetic dispatches addressed to other agents.

  it("filters root user messages by the root session's primary agent", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    // Root session: first user message is with the "build" agent (the
    // human's chosen primary). A later "general"-agent user message is
    // synthetic and must be filtered out.
    const buildUser = (text: string, agent: string): MessageEntry => ({
      info: {
        id: `u_${text}`,
        sessionID: "sess_root",
        role: "user",
        time: { created: 0 },
        agent,
      } as unknown as MessageEntry["info"],
      parts: [
        {
          id: `p_${text}`,
          sessionID: "sess_root",
          messageID: `u_${text}`,
          type: "text",
          text,
        } as MessageEntry["parts"][number],
      ],
    })

    mockedGetSessionMessages.mockResolvedValueOnce([
      buildUser("real-human-1", "build"),
      buildUser("synthetic-dispatch", "general"),
      buildUser("real-human-2", "build"),
    ])

    const { ctx } = buildCtx()
    await handlePermissionEvent(basePermission(), ctx)

    const classifyArgs = mockedClassify.mock.calls[0]?.[0]
    // Only the "build"-agent messages reach the classifier.
    expect(classifyArgs?.userMessages).toEqual([
      "real-human-1",
      "real-human-2",
    ])
  })
})

// ---------------------------------------------------------------------------
// external_directory permission handling
// ---------------------------------------------------------------------------

/**
 * Build a synthetic external_directory permission event using the runtime
 * shape (permission / patterns fields, not SDK-typed type / pattern).
 */
function dirPermission(
  path = "/Users/jacob/Documents/GitHub/premind/*",
  overrides: Partial<{ id: string; sessionID: string }> = {},
) {
  return {
    id: overrides.id ?? "perm_dir_1",
    sessionID: overrides.sessionID ?? "sess_root",
    permission: "external_directory",
    patterns: [path],
  } as never
}

describe("handlePermissionEvent (external_directory)", () => {
  beforeEach(() => {
    // Default: root session resolves to itself, one user message.
    mockedResolveRoot.mockResolvedValue("sess_root")
    mockedGetSessionMessages.mockResolvedValue([
      userEntry("please review the premind project"),
    ])
    // Default: classifySubject returns SAFE.
    mockedClassifySubject.mockResolvedValue({
      verdict: "SAFE",
      reason: "user asked for premind",
    })
    mockedSafe.mockResolvedValue("allow")
  })

  it("calls classifySubject (not classifyCommand) for external_directory", async () => {
    const { ctx } = buildCtx()
    await handlePermissionEvent(dirPermission(), ctx)
    expect(mockedClassifySubject).toHaveBeenCalledTimes(1)
    expect(mockedClassify).not.toHaveBeenCalled()
  })

  it("passes the directory path as subject to classifySubject", async () => {
    const { ctx } = buildCtx()
    await handlePermissionEvent(
      dirPermission("/Users/jacob/Documents/GitHub/premind/*"),
      ctx,
    )
    const args = mockedClassifySubject.mock.calls[0]?.[0]
    expect(args?.subject).toBe("/Users/jacob/Documents/GitHub/premind/*")
  })

  it("auto-approves when classifySubject returns SAFE and safe-path allows", async () => {
    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(dirPermission(), ctx)
    expect(mockedSafe).toHaveBeenCalledTimes(1)
    expect(respondCall).toHaveBeenCalledTimes(1)
  })

  it("escalates via risky-path when classifySubject returns RISKY", async () => {
    mockedClassifySubject.mockResolvedValue({
      verdict: "RISKY",
      reason: "sensitive path",
    })
    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(dirPermission(), ctx)
    expect(mockedRisky).toHaveBeenCalledTimes(1)
    expect(respondCall).not.toHaveBeenCalled()
  })

  it("does not call classifySubject on cache hit; still runs safe-path", async () => {
    const path = "/Users/jacob/Documents/GitHub/premind/*"
    const { ctx } = buildCtx()

    // Pre-populate cache as SAFE.
    ctx.directoryVerdictCache.set(
      DirectoryVerdictCache.keyFor([path]),
      { verdict: "SAFE", reason: "cached" },
      60_000,
    )

    await handlePermissionEvent(dirPermission(path), ctx)

    expect(mockedClassifySubject).not.toHaveBeenCalled()
    expect(mockedSafe).toHaveBeenCalledTimes(1)
  })

  it("populates the cache after a fresh SAFE verdict", async () => {
    const path = "/Users/jacob/Documents/GitHub/premind/*"
    const { ctx } = buildCtx()

    await handlePermissionEvent(dirPermission(path), ctx)

    const cacheKey = DirectoryVerdictCache.keyFor([path])
    const cached = ctx.directoryVerdictCache.get(cacheKey)
    expect(cached).not.toBeNull()
    expect(cached?.verdict.verdict).toBe("SAFE")
  })

  it("does not populate the cache after a RISKY verdict", async () => {
    mockedClassifySubject.mockResolvedValue({
      verdict: "RISKY",
      reason: "sensitive",
    })
    const path = "/Users/jacob/Documents/GitHub/premind/*"
    const { ctx } = buildCtx()

    await handlePermissionEvent(dirPermission(path), ctx)

    const cacheKey = DirectoryVerdictCache.keyFor([path])
    expect(ctx.directoryVerdictCache.get(cacheKey)).toBeNull()
  })

  it("skips external_directory when externalDirectoryEnabled is false", async () => {
    const { ctx } = buildCtx()
    ctx.config = { ...ctx.config, externalDirectoryEnabled: false }

    await handlePermissionEvent(dirPermission(), ctx)

    expect(mockedClassifySubject).not.toHaveBeenCalled()
    expect(mockedClassify).not.toHaveBeenCalled()
    expect(mockedSafe).not.toHaveBeenCalled()
  })

  it("skips external_directory (and all others) when enabled is false", async () => {
    const { ctx } = buildCtx({ enabled: false })
    await handlePermissionEvent(dirPermission(), ctx)
    expect(mockedClassifySubject).not.toHaveBeenCalled()
  })

  it("falls back to TUI prompt when classifySubject returns null", async () => {
    mockedClassifySubject.mockResolvedValue(null)
    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(dirPermission(), ctx)
    expect(respondCall).not.toHaveBeenCalled()
    expect(mockedSafe).not.toHaveBeenCalled()
  })

  it("leaves TUI prompt when user cancels the safe-path countdown", async () => {
    mockedSafe.mockResolvedValue("ask")
    const { ctx, respondCall } = buildCtx()
    await handlePermissionEvent(dirPermission(), ctx)
    expect(respondCall).not.toHaveBeenCalled()
  })
})
