import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./permission/handler.ts", () => ({
  handlePermissionEvent: vi.fn(),
}))

import DelegatedAccess from "./index.ts"
import { handlePermissionEvent } from "./permission/handler.ts"

const mockedHandle = vi.mocked(handlePermissionEvent)

beforeEach(() => {
  mockedHandle.mockReset()
  mockedHandle.mockImplementation(async () => {
    // Default: do nothing.
  })
})

async function makePluginHooks() {
  const pluginInput = {
    client: {} as unknown,
    project: {} as unknown,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://127.0.0.1:1234"),
    $: (() => {}) as unknown,
  }
  // Our plugin registers extra hook keys ("permission.updated") that aren't
  // in the Hooks interface; cast the return type for ergonomic access.
  return (await DelegatedAccess(pluginInput as never)) as unknown as Record<
    string,
    ((...args: unknown[]) => Promise<void>) | undefined
  >
}

function basePermission(overrides: Record<string, unknown> = {}) {
  return {
    id: "perm_1",
    type: "bash",
    pattern: "ls",
    sessionID: "sess_main",
    messageID: "msg_1",
    title: "t",
    metadata: {},
    time: { created: 0 },
    ...overrides,
  }
}

function eventInput(type: string, permission: Record<string, unknown>) {
  return { event: { type, properties: permission } } as never
}

describe("DelegatedAccess plugin entry — shotgun hook registration", () => {
  it("registers config, permission.ask, permission.updated, and event hooks", async () => {
    const hooks = await makePluginHooks()
    expect(typeof hooks["config"]).toBe("function")
    expect(typeof hooks["permission.ask"]).toBe("function")
    expect(typeof hooks["permission.updated"]).toBe("function")
    expect(typeof hooks["event"]).toBe("function")
  })

  // --- permission.ask hook (typed, with output) -------------------------

  it("permission.ask: dispatches with output and hookName='permission.ask'", async () => {
    const hooks = await makePluginHooks()
    const output = { status: "ask" }
    await hooks["permission.ask"]!(basePermission() as never, output as never)

    expect(mockedHandle).toHaveBeenCalledTimes(1)
    const call = mockedHandle.mock.calls[0]
    expect((call?.[0] as { id: string }).id).toBe("perm_1")
    expect(call?.[2]?.hookName).toBe("permission.ask")
    expect(call?.[2]?.output).toBe(output)
  })

  // --- permission.updated hook (untyped) --------------------------------

  it("permission.updated: dispatches with hookName='permission.updated', no output", async () => {
    const hooks = await makePluginHooks()
    // Input shape probe: try raw permission first.
    await hooks["permission.updated"]!(basePermission() as never)

    expect(mockedHandle).toHaveBeenCalledTimes(1)
    const call = mockedHandle.mock.calls[0]
    expect(call?.[2]?.hookName).toBe("permission.updated")
    expect(call?.[2]?.output).toBeUndefined()
  })

  it("permission.updated: extracts permission from input.permission wrapper", async () => {
    const hooks = await makePluginHooks()
    await hooks["permission.updated"]!({
      permission: basePermission({ id: "perm_wrapped" }),
    } as never)

    expect(mockedHandle).toHaveBeenCalledTimes(1)
    const call = mockedHandle.mock.calls[0]
    expect((call?.[0] as { id: string }).id).toBe("perm_wrapped")
  })

  it("permission.updated: silently ignores input without a permission", async () => {
    const hooks = await makePluginHooks()
    await hooks["permission.updated"]!({ nothing: "useful" } as never)
    expect(mockedHandle).not.toHaveBeenCalled()
  })

  // --- event hook (generic) ---------------------------------------------

  it("event: dispatches for permission.asked with hookName='event:permission.asked'", async () => {
    const hooks = await makePluginHooks()
    await hooks["event"]!(eventInput("permission.asked", basePermission()))

    expect(mockedHandle).toHaveBeenCalledTimes(1)
    const call = mockedHandle.mock.calls[0]
    expect(call?.[2]?.hookName).toBe("event:permission.asked")
  })

  it("event: dispatches for permission.updated with hookName='event:permission.updated'", async () => {
    const hooks = await makePluginHooks()
    await hooks["event"]!(
      eventInput("permission.updated", basePermission({ id: "perm_ev_u" })),
    )

    expect(mockedHandle).toHaveBeenCalledTimes(1)
    const call = mockedHandle.mock.calls[0]
    expect(call?.[2]?.hookName).toBe("event:permission.updated")
  })

  it("event: ignores unrelated event types", async () => {
    const hooks = await makePluginHooks()
    await hooks["event"]!(eventInput("session.idle", {}))
    await hooks["event"]!(eventInput("chat.message", {}))
    expect(mockedHandle).not.toHaveBeenCalled()
  })

  // --- cross-hook dedupe ------------------------------------------------

  it("dedupes: the same permissionID is only dispatched once across hooks", async () => {
    const hooks = await makePluginHooks()
    const permission = basePermission({ id: "perm_shared" })

    // Fire the same permission through all three hooks + twice-per-hook.
    await hooks["permission.ask"]!(permission as never, { status: "ask" } as never)
    await hooks["permission.ask"]!(permission as never, { status: "ask" } as never)
    await hooks["permission.updated"]!(permission as never)
    await hooks["permission.updated"]!(permission as never)
    await hooks["event"]!(eventInput("permission.asked", permission))
    await hooks["event"]!(eventInput("permission.updated", permission))

    // Only the first hook that wins gets to dispatch.
    expect(mockedHandle).toHaveBeenCalledTimes(1)
  })

  // --- loop guard -------------------------------------------------------

  it("skips permission events whose sessionID is an ephemeral classifier session", async () => {
    const hooks = await makePluginHooks()

    // First call: normal session. Handler runs and registers a classifier
    // session ID on the shared ephemeralSessionIDs set.
    mockedHandle.mockImplementationOnce(async (_perm, ctx) => {
      ctx.ephemeralSessionIDs.add("sess_classifier")
    })
    await hooks["permission.updated"]!(basePermission({ sessionID: "sess_main" }) as never)

    // Second call: from the classifier session — must be skipped.
    await hooks["permission.updated"]!(
      basePermission({ id: "perm_loop", sessionID: "sess_classifier" }) as never,
    )

    expect(mockedHandle).toHaveBeenCalledTimes(1) // not 2
  })

  // --- input validation -------------------------------------------------

  it("ignores events whose permission lacks an id or sessionID", async () => {
    const hooks = await makePluginHooks()
    await hooks["event"]!({
      event: { type: "permission.asked", properties: {} },
    } as never)
    await hooks["event"]!({
      event: { type: "permission.asked", properties: { id: 123 } },
    } as never)
    expect(mockedHandle).not.toHaveBeenCalled()
  })

  // --- config latching --------------------------------------------------

  it("uses defaults when no config is supplied", async () => {
    const hooks = await makePluginHooks()
    await hooks["permission.updated"]!(basePermission() as never)
    const ctx = mockedHandle.mock.calls[0]?.[1]
    expect(ctx?.config.enabled).toBe(true)
    expect(ctx?.sessionModel).toBeUndefined()
    // Logger is wired through into every dispatch.
    expect(typeof ctx?.log?.info).toBe("function")
    expect(typeof ctx?.log?.error).toBe("function")
  })

  it("latches plugin config from the delegatedAccess key in opencode config", async () => {
    const hooks = await makePluginHooks()
    await hooks["config"]!({
      delegatedAccess: { enabled: false, contextMessageCount: 5 },
    } as never)

    await hooks["permission.updated"]!(basePermission() as never)
    const ctx = mockedHandle.mock.calls[0]?.[1]
    expect(ctx?.config.enabled).toBe(false)
    expect(ctx?.config.contextMessageCount).toBe(5)
  })

  it("falls back to defaults when plugin config is invalid", async () => {
    const hooks = await makePluginHooks()
    await hooks["config"]!({
      delegatedAccess: { enabled: "not a boolean" },
    } as never)

    await hooks["permission.updated"]!(basePermission() as never)
    const ctx = mockedHandle.mock.calls[0]?.[1]
    expect(ctx?.config.enabled).toBe(true)
  })

  it("parses session model from config.model", async () => {
    const hooks = await makePluginHooks()
    await hooks["config"]!({ model: "anthropic/claude-sonnet-4-5" } as never)

    await hooks["permission.updated"]!(basePermission() as never)
    const ctx = mockedHandle.mock.calls[0]?.[1]
    expect(ctx?.sessionModel).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
  })

  it("falls back to config.small_model if config.model is absent", async () => {
    const hooks = await makePluginHooks()
    await hooks["config"]!({ small_model: "openai/gpt-4.1-mini" } as never)

    await hooks["permission.updated"]!(basePermission() as never)
    const ctx = mockedHandle.mock.calls[0]?.[1]
    expect(ctx?.sessionModel).toEqual({
      providerID: "openai",
      modelID: "gpt-4.1-mini",
    })
  })

  // --- error safety -----------------------------------------------------

  it("swallows exceptions from handlePermissionEvent in every hook path", async () => {
    mockedHandle.mockImplementation(async () => {
      throw new Error("unexpected boom")
    })

    const hooks = await makePluginHooks()
    await expect(
      hooks["permission.ask"]!(basePermission() as never, { status: "ask" } as never),
    ).resolves.toBeUndefined()

    // Fresh permission id so dedupe doesn't swallow the call.
    await expect(
      hooks["permission.updated"]!(basePermission({ id: "perm_e_u" }) as never),
    ).resolves.toBeUndefined()

    await expect(
      hooks["event"]!(
        eventInput("permission.asked", basePermission({ id: "perm_e_ev" })),
      ),
    ).resolves.toBeUndefined()
  })
})
