import type { RepoContext } from "./repo-context.ts"

/**
 * One-shot, session-pinned repo-context snapshot.
 *
 * Unlike {@link import("./repo-context.ts").RepoContextCache}, which refreshes
 * on a short TTL to reflect the agent's current location, this class fetches
 * exactly once — at the first `getPinned()` call — and serves that result
 * forever after for the lifetime of the plugin process.
 *
 * Why the once-and-frozen semantic matters for safety:
 *
 *   - The whole point of "PR-scoped elevated trust" is that the human
 *     pre-committed to a particular branch/PR before launching opencode.
 *     If the pinned snapshot could be invalidated by the agent (e.g. via
 *     `git checkout`, `cd`, `gh auth refresh`), it stops being a pre-
 *     commitment and starts being an in-band signal the agent can shape.
 *   - The pin is therefore deliberately not invalidate-able. There is no
 *     `reset()`, no `refresh()`, no expiry. If the human really wants a
 *     fresh pin, they restart opencode.
 *
 * Failure modes:
 *   - If the worktree isn't a git repo at session start, the fetcher
 *     returns `null` and we cache that null forever — no pinned identity
 *     means no elevated trust ever.
 *   - If `gh` is missing or unauthenticated, the fetcher returns a
 *     `RepoContext` without `openPR`. Branch-only pinning is still useful
 *     (the classifier can compare current branch to pinned branch even
 *     without a PR).
 *   - If the fetcher throws unexpectedly, we treat it as null and cache.
 */
export class SessionRepoContext {
  private readonly worktree: string
  private readonly fetcher: (
    worktree: string,
  ) => Promise<RepoContext | null>
  private result: RepoContext | null | undefined = undefined
  private inFlight: Promise<RepoContext | null> | null = null

  constructor(opts: {
    /** Working tree the fetch is scoped to. */
    worktree: string
    /**
     * Function that returns a `RepoContext` (or null) for the worktree.
     * In production this is a thin closure over `fetchRepoContext($, cwd)`
     * — passing the bun shell tag through. Injectable for tests.
     */
    fetcher: (worktree: string) => Promise<RepoContext | null>
  }) {
    this.worktree = opts.worktree
    this.fetcher = opts.fetcher
  }

  /**
   * Return the pinned snapshot. The first call fetches; subsequent calls
   * return the cached value (including cached `null` for "no pin
   * available"). Concurrent first calls coalesce into a single fetcher
   * invocation.
   */
  async getPinned(): Promise<RepoContext | null> {
    if (this.result !== undefined) return this.result
    if (this.inFlight) return this.inFlight

    this.inFlight = this.fetcher(this.worktree)
      .catch(() => null)
      .then((value) => {
        this.result = value
        this.inFlight = null
        return value
      })

    return this.inFlight
  }
}
