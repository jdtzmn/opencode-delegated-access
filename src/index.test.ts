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
  return DelegatedAccess(pluginInput as never)
}

function makePermissionEvent(overrides: {
  type?: string
  id?: string
  sessionID?: string
  permissionType?: string
  pattern?: string | string[]
} = {}) {
  return {
    event: {
      type: overrides.type ?? "permission.asked",
      properties: {
        id: overrides.id ?? "perm_1",
        type: overrides.permissionType ?? "bash",
        pattern: overrides.pattern ?? "ls",
        sessionID: overrides.sessionID ?? "sess_main",
        messageID: "msg_1",
        title: "t",
        metadata: {},
        time: { created: 0 },
      },
    },
  } as never
}

describe("DelegatedAccess plugin entry", () => {
  it("registers the `config` and `event` hooks (not `permission.ask`)", async () => {
    const hooks = await makePluginHooks()
    expect(typeof hooks.config).toBe("function")
    expect(typeof hooks.event).toBe("function")
    expect(hooks["permission.ask" as keyof typeof hooks]).toBeUndefined()
  })

  it("calls handlePermissionEvent for permission.asked events", async () => {
    const hooks = await makePluginHooks()
    await hooks.event!(makePermissionEvent({ type: "permission.asked" }))
    expect(mockedHandle).toHaveBeenCalledTimes(1)
    const [permission, ctx] = mockedHandle.mock.calls[0] ?? []
    expect(permission?.id).toBe("perm_1")
    expect(ctx?.config.enabled).toBe(true) // defaults
  })

  it("calls handlePermissionEvent for permission.updated events", async () => {
    const hooks = await makePluginHooks()
    await hooks.event!(
      makePermissionEvent({ type: "permission.updated", id: "perm_u" }),
    )
    expect(mockedHandle).toHaveBeenCalledTimes(1)
  })

  it("ignores events of unrelated types", async () => {
    const hooks = await makePluginHooks()
    await hooks.event!({
      event: { type: "session.idle", properties: {} },
    } as never)
    await hooks.event!({
      event: { type: "chat.message", properties: {} },
    } as never)
    expect(mockedHandle).not.toHaveBeenCalled()
  })

  it("dedupes: the same permission ID is only handled once across asked+updated", async () => {
    const hooks = await makePluginHooks()
    await hooks.event!(
      makePermissionEvent({ type: "permission.asked", id: "perm_dedupe" }),
    )
    await hooks.event!(
      makePermissionEvent({ type: "permission.updated", id: "perm_dedupe" }),
    )
    await hooks.event!(
      makePermissionEvent({ type: "permission.asked", id: "perm_dedupe" }),
    )
    expect(mockedHandle).toHaveBeenCalledTimes(1)
  })

  it("skips permission events whose sessionID is an ephemeral classifier session", async () => {
    const hooks = await makePluginHooks()

    // Simulate a classifier session running: register its ID via the first
    // invocation's HandlerContext, then emit a permission event from that
    // session and verify we skip it.
    let registeredCtx: {
      ephemeralSessionIDs: Set<string>
    } | undefined
    mockedHandle.mockImplementationOnce(async (_perm, ctx) => {
      registeredCtx = ctx
      ctx.ephemeralSessionIDs.add("sess_classifier")
    })

    // First event: normal session; handler runs and registers "sess_classifier".
    await hooks.event!(
      makePermissionEvent({
        type: "permission.asked",
        id: "perm_first",
        sessionID: "sess_main",
      }),
    )
    expect(registeredCtx?.ephemeralSessionIDs.has("sess_classifier")).toBe(true)

    // Second event: FROM the classifier session — must be skipped.
    await hooks.event!(
      makePermissionEvent({
        type: "permission.asked",
        id: "perm_from_classifier",
        sessionID: "sess_classifier",
      }),
    )
    expect(mockedHandle).toHaveBeenCalledTimes(1) // still 1
  })

  it("ignores events whose properties are missing a permission ID", async () => {
    const hooks = await makePluginHooks()
    await hooks.event!({
      event: { type: "permission.asked", properties: {} },
    } as never)
    await hooks.event!({
      event: { type: "permission.asked", properties: { id: 123 } },
    } as never)
    expect(mockedHandle).not.toHaveBeenCalled()
  })

  it("uses defaults when no config is supplied", async () => {
    const hooks = await makePluginHooks()
    await hooks.event!(makePermissionEvent())

    const ctx = mockedHandle.mock.calls[0]?.[1]
    expect(ctx?.config.enabled).toBe(true)
    expect(ctx?.sessionModel).toBeUndefined()
  })

  it("latches plugin config from the delegatedAccess key in opencode config", async () => {
    const hooks = await makePluginHooks()
    await hooks.config!({
      delegatedAccess: {
        enabled: false,
        contextMessageCount: 5,
      },
    } as never)

    await hooks.event!(makePermissionEvent())
    const ctx = mockedHandle.mock.calls[0]?.[1]
    expect(ctx?.config.enabled).toBe(false)
    expect(ctx?.config.contextMessageCount).toBe(5)
  })

  it("falls back to defaults when plugin config is invalid", async () => {
    const hooks = await makePluginHooks()
    await hooks.config!({
      delegatedAccess: { enabled: "not a boolean" },
    } as never)

    await hooks.event!(makePermissionEvent())
    const ctx = mockedHandle.mock.calls[0]?.[1]
    expect(ctx?.config.enabled).toBe(true) // default restored
  })

  it("parses the session's default model from config.model", async () => {
    const hooks = await makePluginHooks()
    await hooks.config!({
      model: "anthropic/claude-sonnet-4-5",
    } as never)

    await hooks.event!(makePermissionEvent())
    const ctx = mockedHandle.mock.calls[0]?.[1]
    expect(ctx?.sessionModel).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
  })

  it("falls back to config.small_model if config.model is absent", async () => {
    const hooks = await makePluginHooks()
    await hooks.config!({
      small_model: "openai/gpt-4.1-mini",
    } as never)

    await hooks.event!(makePermissionEvent())
    const ctx = mockedHandle.mock.calls[0]?.[1]
    expect(ctx?.sessionModel).toEqual({
      providerID: "openai",
      modelID: "gpt-4.1-mini",
    })
  })

  it("swallows exceptions from handlePermissionEvent", async () => {
    mockedHandle.mockImplementationOnce(async () => {
      throw new Error("unexpected boom")
    })

    const hooks = await makePluginHooks()
    // Should not throw.
    await expect(hooks.event!(makePermissionEvent())).resolves.toBeUndefined()
  })
})
