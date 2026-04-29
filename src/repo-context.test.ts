import { describe, it, expect, vi } from "vitest"
import {
  fetchRepoContext,
  RepoContextCache,
  type BunShellLike,
  type ShellOutput,
  type ShellPromise,
} from "./repo-context.ts"

/**
 * Build a fake bun-shell tag that returns canned outputs based on which
 * command appears in the template literal's interpolated arguments.
 *
 * The handler runs `sh -c <escaped>` so the interpolated arg is the entire
 * shell-escaped command string. We match by substring (e.g. "git rev-parse"
 * or "gh pr view") rather than by exact equality.
 */
function makeShell(
  responders: Array<{
    match: string
    respond: () =>
      | { stdout: string; exitCode: number }
      | Promise<{ stdout: string; exitCode: number }>
      | "throw"
      | "hang"
  }>,
): { $: BunShellLike; calls: string[] } {
  const calls: string[] = []
  const $ = ((_strings: TemplateStringsArray, ...exprs: unknown[]) => {
    // Flatten so [exe, [...rest]] becomes "exe arg1 arg2 ...".
    const flat = exprs.flatMap((e) =>
      Array.isArray(e) ? e.map(String) : [String(e)],
    )
    const cmd = flat.join(" ")
    calls.push(cmd)
    const responder = responders.find((r) => cmd.includes(r.match))

    const buildOutput = (
      stdout: string,
      exitCode: number,
    ): ShellOutput => ({
      exitCode,
      text: () => stdout,
    })

    let resolveResult: (v: ShellOutput) => void = () => {}
    let rejectResult: (e: unknown) => void = () => {}
    const inner = new Promise<ShellOutput>((res, rej) => {
      resolveResult = res
      rejectResult = rej
    })

    // Wrap the inner Promise so .cwd/.quiet/.nothrow chain through.
    const promise = inner as unknown as ShellPromise
    ;(promise as unknown as { cwd: (c: string) => ShellPromise }).cwd = () =>
      promise
    ;(promise as unknown as { quiet: () => ShellPromise }).quiet = () =>
      promise
    ;(promise as unknown as { nothrow: () => ShellPromise }).nothrow = () =>
      promise

    if (!responder) {
      resolveResult(buildOutput("", 1))
    } else {
      Promise.resolve(responder.respond())
        .then((res) => {
          if (res === "throw") {
            rejectResult(new Error("command failed"))
            return
          }
          if (res === "hang") {
            // never resolve
            return
          }
          resolveResult(buildOutput(res.stdout, res.exitCode))
        })
        .catch(rejectResult)
    }

    return promise
  }) as BunShellLike

  return { $, calls }
}

describe("fetchRepoContext", () => {
  it("returns branch + openPR when both shell calls succeed", async () => {
    const { $ } = makeShell([
      {
        match: "git rev-parse",
        respond: () => ({ stdout: "feat/auto-mode\n", exitCode: 0 }),
      },
      {
        match: "gh pr view",
        respond: () => ({
          stdout: JSON.stringify({
            number: 123,
            title: "Add auto-mode classifier",
            baseRefName: "main",
          }),
          exitCode: 0,
        }),
      },
    ])

    const ctx = await fetchRepoContext($, "/tmp/repo")
    expect(ctx).toEqual({
      branch: "feat/auto-mode",
      openPR: {
        number: 123,
        title: "Add auto-mode classifier",
        baseBranch: "main",
      },
    })
  })

  it("returns branch only when no PR is open (gh exits non-zero)", async () => {
    const { $ } = makeShell([
      {
        match: "git rev-parse",
        respond: () => ({ stdout: "feat/foo\n", exitCode: 0 }),
      },
      {
        match: "gh pr view",
        respond: () => ({ stdout: "", exitCode: 1 }),
      },
    ])

    const ctx = await fetchRepoContext($, "/tmp/repo")
    expect(ctx).toEqual({ branch: "feat/foo" })
  })

  it("returns null when not in a git repo (rev-parse fails)", async () => {
    const { $ } = makeShell([
      {
        match: "git rev-parse",
        respond: () => ({ stdout: "", exitCode: 128 }),
      },
    ])

    const ctx = await fetchRepoContext($, "/tmp/notrepo")
    expect(ctx).toBeNull()
  })

  it("returns branch only when gh shell-out throws (gh not installed)", async () => {
    const { $ } = makeShell([
      {
        match: "git rev-parse",
        respond: () => ({ stdout: "main\n", exitCode: 0 }),
      },
      { match: "gh pr view", respond: () => "throw" as const },
    ])

    const ctx = await fetchRepoContext($, "/tmp/repo")
    expect(ctx).toEqual({ branch: "main" })
  })

  it("returns branch only when gh returns malformed JSON", async () => {
    const { $ } = makeShell([
      {
        match: "git rev-parse",
        respond: () => ({ stdout: "main\n", exitCode: 0 }),
      },
      {
        match: "gh pr view",
        respond: () => ({ stdout: "not json", exitCode: 0 }),
      },
    ])

    const ctx = await fetchRepoContext($, "/tmp/repo")
    expect(ctx).toEqual({ branch: "main" })
  })

  it("returns branch only when gh JSON is missing required fields", async () => {
    const { $ } = makeShell([
      {
        match: "git rev-parse",
        respond: () => ({ stdout: "main\n", exitCode: 0 }),
      },
      {
        match: "gh pr view",
        respond: () => ({
          stdout: JSON.stringify({ number: 1 }), // missing title, baseRefName
          exitCode: 0,
        }),
      },
    ])

    const ctx = await fetchRepoContext($, "/tmp/repo")
    expect(ctx).toEqual({ branch: "main" })
  })

  it("renders detached HEAD as '(detached)'", async () => {
    const { $ } = makeShell([
      {
        match: "git rev-parse",
        respond: () => ({ stdout: "HEAD\n", exitCode: 0 }),
      },
      {
        match: "gh pr view",
        respond: () => ({ stdout: "", exitCode: 1 }),
      },
    ])

    const ctx = await fetchRepoContext($, "/tmp/repo")
    expect(ctx?.branch).toBe("(detached)")
  })

  it("trims whitespace and newlines from the branch name", async () => {
    const { $ } = makeShell([
      {
        match: "git rev-parse",
        respond: () => ({ stdout: "  feat/foo  \n\n", exitCode: 0 }),
      },
      {
        match: "gh pr view",
        respond: () => ({ stdout: "", exitCode: 1 }),
      },
    ])

    const ctx = await fetchRepoContext($, "/tmp/repo")
    expect(ctx?.branch).toBe("feat/foo")
  })

  it("returns null when branch is empty after trim", async () => {
    const { $ } = makeShell([
      {
        match: "git rev-parse",
        respond: () => ({ stdout: "  \n", exitCode: 0 }),
      },
    ])

    const ctx = await fetchRepoContext($, "/tmp/repo")
    expect(ctx).toBeNull()
  })
})

describe("RepoContextCache", () => {
  it("calls fetcher on cache miss and caches the value", async () => {
    const fetcher = vi.fn(async () => ({
      branch: "main",
      openPR: undefined,
    }))
    const cache = new RepoContextCache({
      $: ((() => {}) as unknown) as BunShellLike,
      ttlMs: 60_000,
      fetcher,
    })

    const a = await cache.get("/tmp/repo")
    const b = await cache.get("/tmp/repo")

    expect(a).toEqual({ branch: "main", openPR: undefined })
    expect(b).toEqual(a)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("refetches after TTL expires", async () => {
    let call = 0
    const fetcher = vi.fn(async () => ({
      branch: `b${++call}`,
    }))
    const cache = new RepoContextCache({
      $: ((() => {}) as unknown) as BunShellLike,
      ttlMs: 10,
      fetcher,
    })

    const first = await cache.get("/tmp/repo")
    expect(first?.branch).toBe("b1")

    await new Promise((r) => setTimeout(r, 25))

    const second = await cache.get("/tmp/repo")
    expect(second?.branch).toBe("b2")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("coalesces concurrent calls into a single fetcher invocation", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fetcher = vi.fn(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return { branch: "main" }
    })

    const cache = new RepoContextCache({
      $: ((() => {}) as unknown) as BunShellLike,
      ttlMs: 60_000,
      fetcher,
    })

    const results = await Promise.all([
      cache.get("/tmp/repo"),
      cache.get("/tmp/repo"),
      cache.get("/tmp/repo"),
    ])

    for (const r of results) {
      expect(r).toEqual({ branch: "main" })
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(maxInFlight).toBe(1)
  })

  it("caches null on fetcher rejection so subsequent calls don't re-spam", async () => {
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls++
      throw new Error("boom")
    })
    const cache = new RepoContextCache({
      $: ((() => {}) as unknown) as BunShellLike,
      ttlMs: 60_000,
      fetcher,
    })

    const a = await cache.get("/tmp/repo")
    const b = await cache.get("/tmp/repo")

    expect(a).toBeNull()
    expect(b).toBeNull()
    expect(calls).toBe(1)
  })

  it("keys cache entries by cwd", async () => {
    const fetcher = vi.fn(async (_: BunShellLike, cwd: string) => ({
      branch: cwd === "/a" ? "main" : "develop",
    }))
    const cache = new RepoContextCache({
      $: ((() => {}) as unknown) as BunShellLike,
      ttlMs: 60_000,
      fetcher,
    })

    expect((await cache.get("/a"))?.branch).toBe("main")
    expect((await cache.get("/b"))?.branch).toBe("develop")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
