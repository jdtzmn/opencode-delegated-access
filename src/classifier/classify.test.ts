import { describe, it, expect, vi } from "vitest"
import { classifyCommand } from "./classify.ts"
import type { Verdict } from "./parse.ts"

/**
 * Build a mock opencode client whose session.create / prompt / delete methods
 * behave as the individual test scenarios require.
 */
function mockClient(impls: {
  create?: (opts: any) => Promise<any>
  prompt?: (opts: any) => Promise<any>
  del?: (opts: any) => Promise<any>
  abort?: (opts: any) => Promise<any>
}) {
  const calls = {
    create: vi.fn(impls.create ?? (async () => ({ data: { id: "sess_eph" } }))),
    prompt: vi.fn(
      impls.prompt ??
        (async () => ({
          data: {
            info: {},
            parts: [
              { type: "text", text: "VERDICT: SAFE\nREASON: test-default" },
            ],
          },
        })),
    ),
    del: vi.fn(impls.del ?? (async () => ({ data: {} }))),
    abort: vi.fn(impls.abort ?? (async () => ({ data: {} }))),
  }
  return {
    client: {
      session: {
        create: calls.create,
        prompt: calls.prompt,
        delete: calls.del,
        abort: calls.abort,
      },
    } as never,
    calls,
  }
}

const baseArgs = {
  command: "git status",
  userMessages: ["please check the repo state"],
  parentSessionID: "sess_parent",
  model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
  timeoutMs: 5_000,
}

describe("classifyCommand", () => {
  it("returns a SAFE verdict when the classifier responds SAFE", async () => {
    const { client, calls } = mockClient({
      prompt: async () => ({
        data: {
          info: {},
          parts: [
            {
              type: "text",
              text: "VERDICT: SAFE\nREASON: read-only inspection",
            },
          ],
        },
      }),
    })

    const result = await classifyCommand({ ...baseArgs, client })

    expect(result).toEqual<Verdict>({
      verdict: "SAFE",
      reason: "read-only inspection",
    })
    expect(calls.create).toHaveBeenCalledTimes(1)
    expect(calls.prompt).toHaveBeenCalledTimes(1)
    expect(calls.del).toHaveBeenCalledTimes(1)
  })

  it("returns a RISKY verdict when the classifier responds RISKY", async () => {
    const { client } = mockClient({
      prompt: async () => ({
        data: {
          info: {},
          parts: [
            {
              type: "text",
              text: "VERDICT: RISKY\nREASON: destructive rm",
            },
          ],
        },
      }),
    })

    const result = await classifyCommand({
      ...baseArgs,
      command: "rm -rf /",
      client,
    })

    expect(result).toEqual<Verdict>({
      verdict: "RISKY",
      reason: "destructive rm",
    })
  })

  it("creates the ephemeral session as a child (parentID is passed)", async () => {
    const { client, calls } = mockClient({})
    await classifyCommand({ ...baseArgs, client })
    const arg = calls.create.mock.calls[0]?.[0]
    expect(arg?.body?.parentID).toBe("sess_parent")
    expect(arg?.body?.title).toMatch(/delegated-access|classifier/i)
  })

  it("passes model, system, tools, and parts to session.prompt", async () => {
    const { client, calls } = mockClient({})
    await classifyCommand({ ...baseArgs, client })

    const arg = calls.prompt.mock.calls[0]?.[0]
    expect(arg?.path?.id).toBe("sess_eph")
    expect(arg?.body?.model).toEqual(baseArgs.model)
    expect(typeof arg?.body?.system).toBe("string")
    expect(arg?.body?.system.length).toBeGreaterThan(20)
    expect(arg?.body?.tools).toEqual({})
    expect(Array.isArray(arg?.body?.parts)).toBe(true)
    const firstPart = arg?.body?.parts?.[0]
    expect(firstPart?.type).toBe("text")
    expect(firstPart?.text).toContain(baseArgs.command)
  })

  it("deletes the ephemeral session after a successful classification", async () => {
    const { client, calls } = mockClient({})
    await classifyCommand({ ...baseArgs, client })
    const arg = calls.del.mock.calls[0]?.[0]
    expect(arg?.path?.id).toBe("sess_eph")
  })

  it("deletes the ephemeral session even if the prompt throws", async () => {
    const { client, calls } = mockClient({
      prompt: async () => {
        throw new Error("network boom")
      },
    })

    const result = await classifyCommand({ ...baseArgs, client })
    expect(result).toBeNull()
    expect(calls.del).toHaveBeenCalledTimes(1)
  })

  it("returns null when the classifier response is malformed", async () => {
    const { client } = mockClient({
      prompt: async () => ({
        data: {
          info: {},
          parts: [{ type: "text", text: "I am not following instructions" }],
        },
      }),
    })

    const result = await classifyCommand({ ...baseArgs, client })
    expect(result).toBeNull()
  })

  it("returns null when session.create throws (and does not call delete)", async () => {
    const { client, calls } = mockClient({
      create: async () => {
        throw new Error("cannot create")
      },
    })

    const result = await classifyCommand({ ...baseArgs, client })
    expect(result).toBeNull()
    expect(calls.prompt).not.toHaveBeenCalled()
    expect(calls.del).not.toHaveBeenCalled()
  })

  it("returns null when session.create returns no session id", async () => {
    const { client, calls } = mockClient({
      create: async () => ({ data: undefined }),
    })

    const result = await classifyCommand({ ...baseArgs, client })
    expect(result).toBeNull()
    expect(calls.prompt).not.toHaveBeenCalled()
  })

  it("returns null on timeout and attempts to clean up", async () => {
    const { client, calls } = mockClient({
      // Hang forever; the timeout must interrupt.
      prompt: () => new Promise(() => {}),
    })

    const result = await classifyCommand({
      ...baseArgs,
      client,
      timeoutMs: 50,
    })
    expect(result).toBeNull()
    // After timeout we should still try to delete the ephemeral session.
    expect(calls.del).toHaveBeenCalledTimes(1)
  })

  it("swallows delete errors (best-effort cleanup must not mask the verdict)", async () => {
    const { client } = mockClient({
      del: async () => {
        throw new Error("delete failed")
      },
    })
    const result = await classifyCommand({ ...baseArgs, client })
    expect(result).toEqual({ verdict: "SAFE", reason: "test-default" })
  })

  it("concatenates multiple text parts before parsing", async () => {
    const { client } = mockClient({
      prompt: async () => ({
        data: {
          info: {},
          parts: [
            { type: "text", text: "Here is my analysis.\n" },
            { type: "text", text: "VERDICT: SAFE\nREASON: routine" },
          ],
        },
      }),
    })

    const result = await classifyCommand({ ...baseArgs, client })
    expect(result?.verdict).toBe("SAFE")
  })

  it("invokes onEphemeralSessionCreated and onEphemeralSessionDeleted around the classifier call", async () => {
    const { client } = mockClient({})
    const created = vi.fn()
    const deleted = vi.fn()

    await classifyCommand({
      ...baseArgs,
      client,
      onEphemeralSessionCreated: created,
      onEphemeralSessionDeleted: deleted,
    })

    expect(created).toHaveBeenCalledTimes(1)
    expect(created).toHaveBeenCalledWith("sess_eph")
    expect(deleted).toHaveBeenCalledTimes(1)
    expect(deleted).toHaveBeenCalledWith("sess_eph")
    // Order: created before deleted.
    const createdOrder = created.mock.invocationCallOrder[0] ?? 0
    const deletedOrder = deleted.mock.invocationCallOrder[0] ?? 0
    expect(createdOrder).toBeLessThan(deletedOrder)
  })

  it("still invokes onEphemeralSessionDeleted when the prompt throws", async () => {
    const { client } = mockClient({
      prompt: async () => {
        throw new Error("boom")
      },
    })
    const created = vi.fn()
    const deleted = vi.fn()

    await classifyCommand({
      ...baseArgs,
      client,
      onEphemeralSessionCreated: created,
      onEphemeralSessionDeleted: deleted,
    })

    expect(created).toHaveBeenCalledTimes(1)
    expect(deleted).toHaveBeenCalledTimes(1)
  })

  it("does NOT invoke onEphemeralSessionCreated when session.create fails", async () => {
    const { client } = mockClient({
      create: async () => {
        throw new Error("cannot create")
      },
    })
    const created = vi.fn()
    const deleted = vi.fn()

    await classifyCommand({
      ...baseArgs,
      client,
      onEphemeralSessionCreated: created,
      onEphemeralSessionDeleted: deleted,
    })

    expect(created).not.toHaveBeenCalled()
    expect(deleted).not.toHaveBeenCalled()
  })
})
