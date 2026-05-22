/**
 * Repo context (current branch + open PR) provided to the safety classifier
 * as additional decision-shaping signal.
 *
 * Why: a command like `gh pr comment 123` is reasonable when PR 123 is the
 * open PR for the current branch and unreasonable otherwise. The classifier
 * can't make that distinction from the bash command alone — the repo
 * context closes the gap.
 *
 * Cost: one shell-out to `git` (~5-30ms) plus one to `gh pr view`
 * (~100-500ms cold, faster warm). We cache results with a short TTL so
 * back-to-back permission events don't all re-fetch.
 */

/**
 * Minimal type for bun's shell helper as we use it. `@opencode-ai/plugin`
 * declares `BunShell` internally without re-exporting it, so we re-state
 * just the surface we need.
 *
 * Calling the tag returns a "shell promise" with chainable cwd/quiet/
 * nothrow methods that ultimately resolves to an output object with an
 * `exitCode` and a `text()` accessor.
 */
export type ShellOutput = {
  exitCode: number
  text(encoding?: string): string
}
export type ShellPromise = Promise<ShellOutput> & {
  cwd(newCwd: string): ShellPromise
  quiet(): ShellPromise
  nothrow(): ShellPromise
}
export type BunShellLike = (
  strings: TemplateStringsArray,
  ...exprs: unknown[]
) => ShellPromise

export type RepoContext = {
  /** Current branch name; "(detached)" for detached HEAD. */
  branch: string
  /** Open pull request linked to the branch, if any. */
  openPR?: {
    number: number
    title: string
    baseBranch: string
  }
}

/**
 * Dual repo-context snapshot: the pinned identity (captured once at
 * session start and frozen for the lifetime of the plugin process) plus
 * the live identity (refreshed on a short TTL via {@link RepoContextCache}).
 *
 * Surfaced to the safety classifier so it can:
 *   1. Recognise commands that obviously target the human's pre-committed
 *      PR scope (e.g. `gh pr comment N` where N matches `pinned.openPR.number`).
 *   2. Detect mismatch between pinned and current — if the agent has moved
 *      branches/repos mid-session, "elevated trust" for the pinned PR is
 *      withdrawn.
 *
 * Either side may be `null`:
 *   - `pinned: null` means the worktree wasn't a git repo (or `gh` was
 *     unavailable) at session start; no elevated trust is ever granted.
 *   - `current: null` means the live fetch failed or the worktree stopped
 *     being a git repo mid-session.
 */
export type DualRepoContext = {
  pinned: RepoContext | null
  current: RepoContext | null
}

/** Per-shell-out timeout. Keeps a stuck git/gh from blocking forever. */
const SHELL_TIMEOUT_MS = 5_000

/**
 * Run a shell command with a timeout, returning stdout text on success or
 * `null` on any failure (non-zero exit, timeout, command not found, etc.).
 *
 * Bun's shell tag automatically interpolates string-array arguments
 * shell-safely (each element becomes its own argv slot — no quoting bugs).
 * The first array element is the executable name, the remaining are args.
 */
async function runQuiet(
  $: BunShellLike,
  cmd: [string, ...string[]],
  cwd: string,
  timeoutMs: number = SHELL_TIMEOUT_MS,
): Promise<string | null> {
  const [exe, ...rest] = cmd
  const promise = (async () => {
    try {
      const result = await $`${exe} ${rest}`.cwd(cwd).quiet().nothrow()
      if (result.exitCode !== 0) return null
      return result.text()
    } catch {
      return null
    }
  })()

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), timeoutMs),
  )
  return Promise.race([promise, timeout])
}

/**
 * Fetch repo context for `cwd`. Returns:
 *   - `null` if `cwd` is not inside a git repo (everything is best-effort
 *     after that — partial data still returns a useful object).
 *   - A {@link RepoContext} with `openPR` undefined when `gh` is missing,
 *     unauthenticated, or no PR is open for the branch.
 *
 * Never throws.
 */
export async function fetchRepoContext(
  $: BunShellLike,
  cwd: string,
): Promise<RepoContext | null> {
  const branchRaw = await runQuiet(
    $,
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    cwd,
  )
  if (branchRaw === null) return null

  const branch = branchRaw.trim() === "HEAD" ? "(detached)" : branchRaw.trim()
  if (branch.length === 0) return null

  const ghJson = await runQuiet(
    $,
    [
      "gh",
      "pr",
      "view",
      "--json",
      "number,title,baseRefName",
    ],
    cwd,
  )
  if (ghJson === null) return { branch }

  let parsed: unknown
  try {
    parsed = JSON.parse(ghJson)
  } catch {
    return { branch }
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { number?: unknown }).number !== "number" ||
    typeof (parsed as { title?: unknown }).title !== "string" ||
    typeof (parsed as { baseRefName?: unknown }).baseRefName !== "string"
  ) {
    return { branch }
  }

  const pr = parsed as { number: number; title: string; baseRefName: string }
  return {
    branch,
    openPR: {
      number: pr.number,
      title: pr.title,
      baseBranch: pr.baseRefName,
    },
  }
}

type CacheEntry = {
  expiresAt: number
  value: RepoContext | null
}

/**
 * TTL'd cache for {@link fetchRepoContext} results. Coalesces concurrent
 * `get(cwd)` calls into a single in-flight fetch so a burst of permission
 * events doesn't trigger duplicate shell-outs.
 *
 * Branch and PR rarely change in 30s of agent activity, so the default TTL
 * is long enough to amortise the fetch cost across many permissions while
 * short enough that switching branches mid-session is reflected promptly.
 */
export class RepoContextCache {
  private readonly ttlMs: number
  private readonly fetcher: (
    $: BunShellLike,
    cwd: string,
  ) => Promise<RepoContext | null>
  private readonly $: BunShellLike
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<RepoContext | null>>()

  constructor(opts: {
    $: BunShellLike
    ttlMs?: number
    fetcher?: (
      $: BunShellLike,
      cwd: string,
    ) => Promise<RepoContext | null>
  }) {
    this.$ = opts.$
    this.ttlMs = opts.ttlMs ?? 30_000
    this.fetcher = opts.fetcher ?? fetchRepoContext
  }

  async get(cwd: string): Promise<RepoContext | null> {
    const now = Date.now()
    const cached = this.entries.get(cwd)
    if (cached && cached.expiresAt > now) return cached.value

    const existing = this.inFlight.get(cwd)
    if (existing) return existing

    const promise = this.fetcher(this.$, cwd)
      .then((value) => {
        this.entries.set(cwd, { value, expiresAt: Date.now() + this.ttlMs })
        return value
      })
      .catch(() => {
        // Treat unexpected errors as "no context" and cache the negative
        // result so we don't hammer a broken shell on every permission.
        this.entries.set(cwd, {
          value: null,
          expiresAt: Date.now() + this.ttlMs,
        })
        return null
      })
      .finally(() => {
        this.inFlight.delete(cwd)
      })

    this.inFlight.set(cwd, promise)
    return promise
  }
}

/**
 * Type guard that narrows a value to {@link DualRepoContext}. Returns true
 * when the value has both `pinned` and `current` keys, false when it's a
 * single-snapshot {@link RepoContext} (or anything else).
 *
 * Exported so the classifier prompt renderer and the permission handler
 * can share one discriminator instead of duplicating the same `"pinned"
 * in x && "current" in x` check across files.
 */
export function isDualRepoContext(
  x: DualRepoContext | RepoContext,
): x is DualRepoContext {
  return (
    typeof x === "object" &&
    x !== null &&
    "pinned" in x &&
    "current" in x
  )
}
