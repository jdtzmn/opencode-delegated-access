import { describe, it, expect, vi } from "vitest"
import { SessionRepoContext } from "./session-repo-context.ts"
import type { RepoContext } from "./repo-context.ts"

describe("SessionRepoContext", () => {
  it("fetches once and returns the same result on subsequent calls", async () => {
    const fetcher = vi.fn(async (): Promise<RepoContext | null> => ({
      branch: "feat/x",
      openPR: { number: 1, title: "X", baseBranch: "main" },
    }))
    const session = new SessionRepoContext({ fetcher, worktree: "/repo" })

    const first = await session.getPinned()
    const second = await session.getPinned()
    const third = await session.getPinned()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(second).toEqual(third)
    expect(first?.branch).toBe("feat/x")
  })

  it("passes the worktree to the fetcher exactly once", async () => {
    const fetcher = vi.fn(
      async (_worktree: string): Promise<RepoContext | null> => null,
    )
    const session = new SessionRepoContext({
      fetcher,
      worktree: "/some/worktree",
    })

    await session.getPinned()
    await session.getPinned()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe("/some/worktree")
  })

  it("caches a null result (no re-fetch when worktree isn't a git repo)", async () => {
    const fetcher = vi.fn(async (): Promise<RepoContext | null> => null)
    const session = new SessionRepoContext({ fetcher, worktree: "/repo" })

    expect(await session.getPinned()).toBeNull()
    expect(await session.getPinned()).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("coalesces concurrent first-call fetches into a single fetcher invocation", async () => {
    let resolveFetcher: (v: RepoContext | null) => void = () => {}
    const fetcher = vi.fn(
      () =>
        new Promise<RepoContext | null>((resolve) => {
          resolveFetcher = resolve
        }),
    )
    const session = new SessionRepoContext({ fetcher, worktree: "/repo" })

    const a = session.getPinned()
    const b = session.getPinned()
    const c = session.getPinned()
    expect(fetcher).toHaveBeenCalledTimes(1)

    resolveFetcher({ branch: "feat/y" })

    expect((await a)?.branch).toBe("feat/y")
    expect((await b)?.branch).toBe("feat/y")
    expect((await c)?.branch).toBe("feat/y")
  })

  it("caches a fetcher rejection as null and never re-tries", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("boom")
    })
    const session = new SessionRepoContext({ fetcher, worktree: "/repo" })

    expect(await session.getPinned()).toBeNull()
    expect(await session.getPinned()).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
