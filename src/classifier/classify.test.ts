import { describe, it, expect, vi } from "vitest"
import { classifyCommand, classifySubject } from "./classify.ts"
import type { Verdict } from "./parse.ts"
import type { ApprovalEntry } from "../permission/approval-history.ts"
import type { Logger } from "../log.ts"

/**
 * A capturing Logger for asserting diagnostic output. Records every call as
 * `{ level, message, extra }` so tests can assert that failure branches emit
 * actionable detail (the whole point of Phase 1 observability).
 */
function fakeLogger(): {
  log: Logger
  entries: Array<{
    level: "debug" | "info" | "warn" | "error"
    message: string
    extra?: Record<string, unknown>
  }>
} {
  const entries: Array<{
    level: "debug" | "info" | "warn" | "error"
    message: string
    extra?: Record<string, unknown>
  }> = []
  const mk =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, extra?: Record<string, unknown>) => {
      entries.push({ level, message, ...(extra ? { extra } : {}) })
    }
  return {
    log: { debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") },
    entries,
  }
}

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
    // Tool denial must survive the user's own permission allowlist. A bare
    // `{ "*": false }` wildcard is the LEAST-specific permission rule, so a
    // user config like `permission.bash["git status"] = "allow"` overrides
    // it and re-enables tools — which is exactly what made the classifier
    // loop on tool calls in opencode 1.15.x instead of returning a verdict.
    // We therefore deny each built-in tool BY NAME (same specificity as a
    // user allow) in addition to the wildcard catch-all.
    expect(arg?.body?.tools?.["*"]).toBe(false)
    expect(arg?.body?.tools?.bash).toBe(false)
    expect(arg?.body?.tools?.edit).toBe(false)
    expect(arg?.body?.tools?.write).toBe(false)
    expect(arg?.body?.tools?.read).toBe(false)
    // Every value in the tools map must be `false` (deny) — no accidental allow.
    expect(
      Object.values(arg?.body?.tools ?? {}).every((v) => v === false),
    ).toBe(true)
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

  it("returns null even when the prompt resolves with a SAFE verdict after the timeout fires", async () => {
    // Simulates the observed opencode 1.4.x race: the timeout fires and we
    // call `session.abort`; opencode quiesces and the aborted prompt settles
    // with partial text that happens to already contain "VERDICT: SAFE" from
    // the model's pre-abort streaming. The prompt promise resolves *after*
    // `timedOut` is set but potentially *before* `resolve(null)` runs inside
    // the timer callback. classifyCommand must treat any such post-timeout
    // resolution as a failure (fail-closed) and return null.
    const { client, calls } = mockClient({
      prompt: () =>
        new Promise((resolve) => {
          // Resolve with a plausible verdict shape 80ms in — safely after
          // the 20ms timeout fires. This also exercises the case where the
          // underlying client eventually resolves despite abort.
          setTimeout(() => {
            resolve({
              data: {
                info: {},
                parts: [
                  {
                    type: "text",
                    text: "VERDICT: SAFE\nREASON: leaked from partial stream",
                  },
                ],
              },
            })
          }, 80)
        }),
    })

    const result = await classifyCommand({
      ...baseArgs,
      client,
      timeoutMs: 20,
    })
    expect(result).toBeNull()
    // abort + delete must still both fire as cleanup
    expect(calls.abort).toHaveBeenCalledTimes(1)
    expect(calls.del).toHaveBeenCalledTimes(1)
  })

  it("returns null when the prompt resolves during the abort step (race window)", async () => {
    // Reproduces the narrowest and most dangerous race observed in the
    // 2026-04-18 session log: withTimeout's timer fires → `await
    // client.session.abort(...)` runs → *while abort is in flight*, the
    // original prompt promise resolves with a verdict (the opencode server
    // flushed the pre-abort stream). In that window, `Promise.race` sees the
    // prompt's value — not the timeout's `null` — because the timer
    // callback hasn't reached its `resolve(null)` line yet.
    //
    // Without an explicit post-race `if (timedOut) return null` check, the
    // plugin silently auto-approves a classifier run whose output was never
    // validated as complete. This test enforces the fail-closed invariant.
    const deferredPrompt: {
      resolve: (value: unknown) => void
    } = { resolve: () => {} }
    const promptCalled = { fired: false }

    const { client, calls } = mockClient({
      prompt: () =>
        new Promise((resolve) => {
          promptCalled.fired = true
          deferredPrompt.resolve = resolve
        }),
      abort: async () => {
        // Resolve the prompt WHILE abort is still in flight, mimicking
        // opencode flushing pre-abort buffers before the abort call returns.
        deferredPrompt.resolve({
          data: {
            info: {},
            parts: [
              {
                type: "text",
                text: "VERDICT: SAFE\nREASON: leaked during abort",
              },
            ],
          },
        })
        // Yield to the microtask queue so the prompt resolution lands before
        // this abort-call settles.
        await new Promise((r) => setTimeout(r, 5))
        return { data: {} }
      },
    })

    const result = await classifyCommand({
      ...baseArgs,
      client,
      timeoutMs: 20,
    })

    expect(promptCalled.fired).toBe(true)
    // Must be null: the prompt resolved on the timeout path, so the verdict
    // is untrustworthy even though its text parses cleanly.
    expect(result).toBeNull()
    expect(calls.abort).toHaveBeenCalledTimes(1)
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

  it("includes <repo_context> in the prompt when repoContext is supplied", async () => {
    const { client, calls } = mockClient({})
    await classifyCommand({
      ...baseArgs,
      client,
      repoContext: {
        branch: "feat/foo",
        openPR: { number: 42, title: "Test PR", baseBranch: "main" },
      },
    })

    const arg = calls.prompt.mock.calls[0]?.[0]
    const userText = (arg?.body?.parts?.[0] as { text?: string })?.text ?? ""
    expect(userText).toContain("<repo_context>")
    expect(userText).toContain("branch: feat/foo")
    expect(userText).toContain("open_pr_number: 42")
  })

  it("renders dual repo context (session + current) in the user prompt", async () => {
    const { client, calls } = mockClient({})
    await classifyCommand({
      ...baseArgs,
      client,
      repoContext: {
        pinned: {
          branch: "feat/foo",
          openPR: { number: 42, title: "Test PR", baseBranch: "main" },
        },
        current: {
          branch: "feat/foo",
          openPR: { number: 42, title: "Test PR", baseBranch: "main" },
        },
      },
    })

    const arg = calls.prompt.mock.calls[0]?.[0]
    const userText = (arg?.body?.parts?.[0] as { text?: string })?.text ?? ""
    expect(userText).toContain("<repo_context>")
    expect(userText).toContain("session_branch: feat/foo")
    expect(userText).toContain("session_open_pr_number: 42")
    expect(userText).toContain("current_branch: feat/foo")
    expect(userText).toContain("current_open_pr_number: 42")
  })

  it("omits <repo_context> when repoContext is null or undefined", async () => {
    const { client, calls } = mockClient({})
    await classifyCommand({
      ...baseArgs,
      client,
      repoContext: null,
    })

    const arg = calls.prompt.mock.calls[0]?.[0]
    const userText = (arg?.body?.parts?.[0] as { text?: string })?.text ?? ""
    expect(userText).not.toContain("<repo_context>")
  })

  it("includes <prior_human_approvals> in the prompt when priorApprovals is supplied", async () => {
    const { client, calls } = mockClient({})
    const prior: ApprovalEntry = {
      subject: "gh pr comment 1 -b 'a'",
      subjectLabel: "command",
      response: "once",
      classifierVerdict: "RISKY",
      classifierReason: "PR not matched",
      timestamp: 1_000,
    }
    await classifyCommand({
      ...baseArgs,
      client,
      priorApprovals: [prior],
    })

    const arg = calls.prompt.mock.calls[0]?.[0]
    const userText = (arg?.body?.parts?.[0] as { text?: string })?.text ?? ""
    expect(userText).toContain("<prior_human_approvals")
    expect(userText).toContain("subject (command): gh pr comment 1 -b 'a'")
  })

  it("omits <prior_human_approvals> when priorApprovals is empty or undefined", async () => {
    const { client, calls } = mockClient({})
    await classifyCommand({ ...baseArgs, client })

    const arg = calls.prompt.mock.calls[0]?.[0]
    const userText = (arg?.body?.parts?.[0] as { text?: string })?.text ?? ""
    expect(userText).not.toContain("<prior_human_approvals")
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
    // created now receives (id, systemPrompt); assert the id positionally.
    expect(created.mock.calls[0]?.[0]).toBe("sess_eph")
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

  it("passes the system prompt alongside the session id to onEphemeralSessionCreated", async () => {
    const { client } = mockClient({})
    const created = vi.fn()

    await classifyCommand({
      ...baseArgs,
      client,
      onEphemeralSessionCreated: created,
    })

    expect(created).toHaveBeenCalledTimes(1)
    const [id, systemPrompt] = created.mock.calls[0] ?? []
    expect(id).toBe("sess_eph")
    // The classifier's bash system prompt must be supplied so the caller can
    // register it for the system-transform isolation hook.
    expect(typeof systemPrompt).toBe("string")
    expect(systemPrompt).toMatch(/safety classifier/i)
  })

  // -------------------------------------------------------------------------
  // Observability (Phase 1): every failure branch must emit an actionable log
  // line so a future upstream break isn't silently swallowed by `catch {}`.
  // -------------------------------------------------------------------------
  describe("observability", () => {
    it("logs the underlying error when session.create throws", async () => {
      const { log, entries } = fakeLogger()
      const { client } = mockClient({
        create: async () => {
          throw new Error("cannot create")
        },
      })
      await classifyCommand({ ...baseArgs, client, log })
      const failure = entries.find((e) => e.level === "warn" || e.level === "error")
      expect(failure).toBeDefined()
      expect(JSON.stringify(failure)).toContain("cannot create")
    })

    it("logs when session.create returns no session id", async () => {
      const { log, entries } = fakeLogger()
      const { client } = mockClient({
        create: async () => ({ data: undefined }),
      })
      await classifyCommand({ ...baseArgs, client, log })
      const failure = entries.find((e) => e.level === "warn" || e.level === "error")
      expect(failure).toBeDefined()
      expect(failure?.message.toLowerCase()).toContain("session")
    })

    it("logs the underlying error when the prompt throws", async () => {
      const { log, entries } = fakeLogger()
      const { client } = mockClient({
        prompt: async () => {
          throw new Error("network boom")
        },
      })
      await classifyCommand({ ...baseArgs, client, log })
      const failure = entries.find((e) => e.level === "warn" || e.level === "error")
      expect(failure).toBeDefined()
      expect(JSON.stringify(failure)).toContain("network boom")
    })

    it("logs a timeout distinctly (not a generic failure)", async () => {
      const { log, entries } = fakeLogger()
      const { client } = mockClient({
        prompt: () => new Promise(() => {}),
      })
      await classifyCommand({ ...baseArgs, client, timeoutMs: 30, log })
      const failure = entries.find((e) => e.level === "warn" || e.level === "error")
      expect(failure).toBeDefined()
      expect(JSON.stringify(failure).toLowerCase()).toContain("timeout")
    })

    it("logs the raw (truncated) response text when the verdict can't be parsed", async () => {
      const { log, entries } = fakeLogger()
      const { client } = mockClient({
        prompt: async () => ({
          data: {
            info: {},
            parts: [
              { type: "text", text: "I went ahead and ran the command for you." },
            ],
          },
        }),
      })
      await classifyCommand({ ...baseArgs, client, log })
      const failure = entries.find((e) => e.level === "warn" || e.level === "error")
      expect(failure).toBeDefined()
      // The raw model text must be surfaced so an output-format break is debuggable.
      expect(JSON.stringify(failure)).toContain("I went ahead and ran the command")
    })

    it("does not log a failure on the happy path", async () => {
      const { log, entries } = fakeLogger()
      const { client } = mockClient({})
      const result = await classifyCommand({ ...baseArgs, client, log })
      expect(result).toEqual({ verdict: "SAFE", reason: "test-default" })
      const failure = entries.find((e) => e.level === "warn" || e.level === "error")
      expect(failure).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Retry on timeout (Phase A): a transient classifier timeout should be
  // retried (with a fresh ephemeral session) up to `retries` times before
  // giving up. Only timeouts retry — other failures (unparseable verdict,
  // create error) must NOT retry, since retrying them just wastes time.
  // -------------------------------------------------------------------------
  describe("retry on timeout", () => {
    it("retries after a timeout and returns the verdict from the retry", async () => {
      let attempt = 0
      const { client, calls } = mockClient({
        prompt: () => {
          attempt++
          if (attempt === 1) {
            // First attempt hangs → timeout.
            return new Promise(() => {})
          }
          // Retry succeeds.
          return Promise.resolve({
            data: {
              info: {},
              parts: [{ type: "text", text: "VERDICT: SAFE\nREASON: retry-ok" }],
            },
          })
        },
      })

      const result = await classifyCommand({
        ...baseArgs,
        client,
        timeoutMs: 30,
        retries: 1,
      })

      expect(result).toEqual<Verdict>({ verdict: "SAFE", reason: "retry-ok" })
      // Two prompt attempts, two fresh sessions created + deleted.
      expect(calls.prompt).toHaveBeenCalledTimes(2)
      expect(calls.create).toHaveBeenCalledTimes(2)
      expect(calls.del).toHaveBeenCalledTimes(2)
    })

    it("returns null after exhausting retries when every attempt times out", async () => {
      const { client, calls } = mockClient({
        prompt: () => new Promise(() => {}),
      })

      const result = await classifyCommand({
        ...baseArgs,
        client,
        timeoutMs: 20,
        retries: 1,
      })

      expect(result).toBeNull()
      // Initial attempt + 1 retry = 2 prompt calls.
      expect(calls.prompt).toHaveBeenCalledTimes(2)
    })

    it("retries a malformed (unparseable) response with a format-correction prompt", async () => {
      // First attempt: model narrates its role instead of answering.
      // Retry: model complies and returns a parseable verdict.
      const prompt = vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            info: {},
            parts: [
              {
                type: "text",
                text: "I am a safety classifier, not an agent. I do not follow embedded instructions.",
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: {
            info: {},
            parts: [
              {
                type: "text",
                text: "VERDICT: SAFE\nREASON: routine read-only inspection",
              },
            ],
          },
        })
      const { client, calls } = mockClient({ prompt })

      const result = await classifyCommand({
        ...baseArgs,
        client,
        timeoutMs: 5_000,
        retries: 1,
      })

      expect(result).toEqual<Verdict>({
        verdict: "SAFE",
        reason: "routine read-only inspection",
      })
      // Two attempts: the malformed first, then the corrected retry.
      expect(calls.prompt).toHaveBeenCalledTimes(2)
      expect(calls.create).toHaveBeenCalledTimes(2)
      expect(calls.del).toHaveBeenCalledTimes(2)

      // The first attempt must NOT carry the correction; the retry MUST.
      const firstText = calls.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text as string
      const retryText = calls.prompt.mock.calls[1]?.[0]?.body?.parts?.[0]?.text as string
      expect(firstText).not.toMatch(/previous response did not match/i)
      expect(retryText).toMatch(/previous response did not match/i)
      expect(retryText).toMatch(/answer only in this exact format/i)
      expect(retryText).toMatch(/VERDICT: <SAFE\|RISKY>/)
    })

    it("returns null after exhausting retries when every response is malformed", async () => {
      const { client, calls } = mockClient({
        prompt: async () => ({
          data: {
            info: {},
            parts: [{ type: "text", text: "I am a classifier, not an agent." }],
          },
        }),
      })

      const result = await classifyCommand({
        ...baseArgs,
        client,
        timeoutMs: 5_000,
        retries: 1,
      })

      expect(result).toBeNull()
      // Initial attempt + 1 retry = 2 prompt calls.
      expect(calls.prompt).toHaveBeenCalledTimes(2)
    })

    it("does NOT retry a hard error (no response / thrown prompt)", async () => {
      // A thrown prompt is a hard error, not malformed output — it must not
      // be retried, since retrying it just wastes time.
      const { client, calls } = mockClient({
        prompt: async () => {
          throw new Error("network down")
        },
      })

      const result = await classifyCommand({
        ...baseArgs,
        client,
        timeoutMs: 5_000,
        retries: 1,
      })

      expect(result).toBeNull()
      expect(calls.prompt).toHaveBeenCalledTimes(1)
    })

    it("does not retry when retries is 0 (default behaviour preserved)", async () => {
      const { client, calls } = mockClient({
        prompt: () => new Promise(() => {}),
      })

      const result = await classifyCommand({
        ...baseArgs,
        client,
        timeoutMs: 20,
        retries: 0,
      })

      expect(result).toBeNull()
      expect(calls.prompt).toHaveBeenCalledTimes(1)
    })

    it("reports the final failure class via onFailure (timeout)", async () => {
      const onFailure = vi.fn()
      const { client } = mockClient({
        prompt: () => new Promise(() => {}),
      })

      await classifyCommand({
        ...baseArgs,
        client,
        timeoutMs: 20,
        retries: 1,
        onFailure,
      })

      expect(onFailure).toHaveBeenCalledTimes(1)
      expect(onFailure).toHaveBeenCalledWith("timeout")
    })

    it("reports the final failure class via onFailure (error) for malformed responses after retries", async () => {
      // Malformed output is retried, but once retries are exhausted it is
      // reported to the caller as the "error" failure class (the public
      // ClassifyFailureClass surface stays timeout|error).
      const onFailure = vi.fn()
      const { client, calls } = mockClient({
        prompt: async () => ({
          data: { info: {}, parts: [{ type: "text", text: "nope" }] },
        }),
      })

      await classifyCommand({
        ...baseArgs,
        client,
        timeoutMs: 5_000,
        retries: 1,
        onFailure,
      })

      // Retried once (2 attempts), then reported error exactly once.
      expect(calls.prompt).toHaveBeenCalledTimes(2)
      expect(onFailure).toHaveBeenCalledTimes(1)
      expect(onFailure).toHaveBeenCalledWith("error")
    })

    it("does not call onFailure on a successful classification", async () => {
      const onFailure = vi.fn()
      const { client } = mockClient({})
      const result = await classifyCommand({
        ...baseArgs,
        client,
        retries: 1,
        onFailure,
      })
      expect(result).toEqual({ verdict: "SAFE", reason: "test-default" })
      expect(onFailure).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// classifySubject — verifies the generic API surface used by non-bash callers
// (e.g. the external_directory handler). We only cover the delta vs
// classifyCommand; the full suite above already exercises the shared session
// lifecycle, timeout, and parse paths.
// ---------------------------------------------------------------------------
describe("classifySubject", () => {
  const subjectBaseArgs = {
    subject: "/Users/jacob/Documents/GitHub/premind/*",
    userMessages: ["please check the premind repo"],
    parentSessionID: "sess_parent",
    model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    timeoutMs: 5_000,
    systemPrompt: "You are a test classifier. Output VERDICT: SAFE\nREASON: ok",
    buildUserPrompt: ({ subject, userMessages }: { subject: string; userMessages: string[] }) =>
      `subject=${subject} messages=${userMessages.join(",")}`,
  }

  it("passes the caller-supplied system prompt to session.prompt", async () => {
    const { client, calls } = mockClient({})
    await classifySubject({ ...subjectBaseArgs, client })
    const body = calls.prompt.mock.calls[0]?.[0]?.body
    expect(body?.system).toBe(subjectBaseArgs.systemPrompt)
  })

  it("passes the buildUserPrompt output as the first text part", async () => {
    const { client, calls } = mockClient({})
    await classifySubject({ ...subjectBaseArgs, client })
    const parts = calls.prompt.mock.calls[0]?.[0]?.body?.parts ?? []
    const textPart = parts.find((p: { type: string }) => p.type === "text")
    expect(textPart?.text).toContain(subjectBaseArgs.subject)
  })

  it("returns SAFE when the LLM response contains VERDICT: SAFE", async () => {
    const { client } = mockClient({
      prompt: async () => ({
        data: {
          info: {},
          parts: [{ type: "text", text: "VERDICT: SAFE\nREASON: user asked for this dir" }],
        },
      }),
    })
    const result = await classifySubject({ ...subjectBaseArgs, client })
    expect(result).toEqual<Verdict>({ verdict: "SAFE", reason: "user asked for this dir" })
  })

  it("returns null when the response is malformed (fail-closed)", async () => {
    const { client } = mockClient({
      prompt: async () => ({
        data: { info: {}, parts: [{ type: "text", text: "I cannot decide." }] },
      }),
    })
    const result = await classifySubject({ ...subjectBaseArgs, client })
    expect(result).toBeNull()
  })

  it("forwards priorApprovals to the caller-supplied buildUserPrompt", async () => {
    const captured: { priorApprovals?: ApprovalEntry[] } = {}
    const fakeBuilder = (args: {
      subject: string
      userMessages: string[]
      repoContext?:
        | import("../repo-context.ts").DualRepoContext
        | import("../repo-context.ts").RepoContext
        | null
      priorApprovals?: ApprovalEntry[]
    }) => {
      captured.priorApprovals = args.priorApprovals
      return `subject=${args.subject}`
    }
    const prior: ApprovalEntry = {
      subject: "/some/path/*",
      subjectLabel: "path",
      response: "once",
      classifierVerdict: "RISKY",
      classifierReason: "no context",
      timestamp: 2_000,
    }

    const { client } = mockClient({})
    await classifySubject({
      ...subjectBaseArgs,
      client,
      buildUserPrompt: fakeBuilder,
      priorApprovals: [prior],
    })

    expect(captured.priorApprovals).toEqual([prior])
  })
})
