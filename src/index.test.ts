import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the child modules so we can assert on wiring without running real
// notifications or LLM calls.
vi.mock("./permission/handler.ts", () => ({
  handlePermission: vi.fn(),
}))

import DelegatedAccess from "./index.ts"
import { handlePermission } from "./permission/handler.ts"

const mockedHandle = vi.mocked(handlePermission)

beforeEach(() => {
  mockedHandle.mockReset()
  mockedHandle.mockImplementation(async () => {
    // Default: do nothing to output.
  })
})

async function makePluginHooks(overrides: {
  client?: unknown
} = {}) {
  const pluginInput = {
    client: overrides.client ?? ({} as unknown),
    project: {} as unknown,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://127.0.0.1:1234"),
    $: (() => {}) as unknown,
  }
  return DelegatedAccess(pluginInput as never)
}

describe("DelegatedAccess plugin entry", () => {
  it("returns hooks with config + permission.ask registered", async () => {
    const hooks = await makePluginHooks()
    expect(typeof hooks.config).toBe("function")
    expect(typeof hooks["permission.ask"]).toBe("function")
  })

  it("uses defaults when no config is supplied (no config hook invocation)", async () => {
    const hooks = await makePluginHooks()

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    const input = {
      id: "perm",
      type: "bash",
      pattern: "ls",
      sessionID: "s",
      messageID: "m",
      title: "t",
      metadata: {},
      time: { created: 0 },
    } as never

    await hooks["permission.ask"]!(input, output)

    expect(mockedHandle).toHaveBeenCalledTimes(1)
    const ctx = mockedHandle.mock.calls[0]?.[2]
    // Default config.enabled is true.
    expect(ctx?.config.enabled).toBe(true)
    // sessionModel undefined because config hook never ran.
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

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    const input = {
      id: "perm",
      type: "bash",
      pattern: "ls",
      sessionID: "s",
      messageID: "m",
      title: "t",
      metadata: {},
      time: { created: 0 },
    } as never

    await hooks["permission.ask"]!(input, output)
    const ctx = mockedHandle.mock.calls[0]?.[2]
    expect(ctx?.config.enabled).toBe(false)
    expect(ctx?.config.contextMessageCount).toBe(5)
  })

  it("falls back to defaults when plugin config is invalid (rather than crashing)", async () => {
    const hooks = await makePluginHooks()

    await hooks.config!({
      delegatedAccess: { enabled: "not a boolean" },
    } as never)

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    const input = {
      id: "perm",
      type: "bash",
      pattern: "ls",
      sessionID: "s",
      messageID: "m",
      title: "t",
      metadata: {},
      time: { created: 0 },
    } as never

    await hooks["permission.ask"]!(input, output)
    const ctx = mockedHandle.mock.calls[0]?.[2]
    // Should have reverted to defaults.
    expect(ctx?.config.enabled).toBe(true)
  })

  it("parses the session's default model from the config.model field", async () => {
    const hooks = await makePluginHooks()

    await hooks.config!({
      model: "anthropic/claude-sonnet-4-5",
    } as never)

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    const input = {
      id: "perm",
      type: "bash",
      pattern: "ls",
      sessionID: "s",
      messageID: "m",
      title: "t",
      metadata: {},
      time: { created: 0 },
    } as never

    await hooks["permission.ask"]!(input, output)
    const ctx = mockedHandle.mock.calls[0]?.[2]
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

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    const input = {
      id: "perm",
      type: "bash",
      pattern: "ls",
      sessionID: "s",
      messageID: "m",
      title: "t",
      metadata: {},
      time: { created: 0 },
    } as never

    await hooks["permission.ask"]!(input, output)
    const ctx = mockedHandle.mock.calls[0]?.[2]
    expect(ctx?.sessionModel).toEqual({
      providerID: "openai",
      modelID: "gpt-4.1-mini",
    })
  })

  it("swallows exceptions from handlePermission and sets output.status='ask'", async () => {
    mockedHandle.mockImplementationOnce(async () => {
      throw new Error("unexpected boom")
    })

    const hooks = await makePluginHooks()
    const output = { status: "allow" as "ask" | "allow" | "deny" }
    const input = {
      id: "perm",
      type: "bash",
      pattern: "ls",
      sessionID: "s",
      messageID: "m",
      title: "t",
      metadata: {},
      time: { created: 0 },
    } as never

    // Should not throw.
    await hooks["permission.ask"]!(input, output)
    expect(output.status).toBe("ask")
  })
})
