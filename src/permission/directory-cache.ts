import type { Verdict } from "../classifier/parse.ts"

/**
 * A cached verdict entry together with its wall-clock expiry time.
 */
export type CachedVerdict = {
  verdict: Verdict
  expiresAt: number
}

/**
 * In-memory, per-plugin-lifetime cache for recent `external_directory`
 * classification verdicts.
 *
 * ## Why only SAFE verdicts are cached
 *
 * A RISKY verdict means the user should review each occurrence. Caching RISKY
 * results would suppress the notification that lets the user see and respond
 * to the escalation. SAFE verdicts, by contrast, are correct to reuse within a
 * short window: if the user recently asked the agent to work in a given
 * directory, a burst of sub-second permission requests for the same path
 * (common when an agent does `glob` / `grep` across a tree) all deserve the
 * same decision.
 *
 * ## Key scheme
 *
 * Keys are derived from the permission's `patterns` array. Usually this is a
 * single-element array (e.g. `["/Users/jacob/Documents/GitHub/myrepo/*"]`), but
 * the joiner uses a NUL byte as delimiter so multi-element arrays are
 * unambiguous. The key is passed through as-is; no path normalisation is
 * applied so the semantics stay simple and predictable.
 *
 * ## TTL
 *
 * Entries expire lazily on the next `get` call. No background timer is needed
 * for the short 60-second default TTL — the small number of entries and the
 * per-get expiry check is cheap.
 */
export class DirectoryVerdictCache {
  private readonly _entries = new Map<string, CachedVerdict>()
  private readonly _now: () => number

  /**
   * @param now - Clock function, injectable for deterministic tests.
   *   Defaults to `Date.now`.
   */
  constructor(now: () => number = Date.now) {
    this._now = now
  }

  /**
   * Derive the cache key for a given patterns array.
   * The separator `\u0001` (SOH) is unlikely to appear in real paths.
   */
  static keyFor(patterns: string[]): string {
    return patterns.join("\u0001")
  }

  /**
   * Look up a verdict for `patternKey`. Returns `null` when the key is absent
   * or the entry has expired (expired entries are deleted on access).
   */
  get(patternKey: string): CachedVerdict | null {
    const entry = this._entries.get(patternKey)
    if (!entry) return null
    if (this._now() >= entry.expiresAt) {
      this._entries.delete(patternKey)
      return null
    }
    return entry
  }

  /**
   * Store a verdict under `patternKey` for `ttlMs` milliseconds.
   * Only SAFE verdicts are stored; RISKY verdicts are silently ignored so
   * the caller can unconditionally call `set` without an `if` guard.
   */
  set(patternKey: string, verdict: Verdict, ttlMs: number): void {
    if (verdict.verdict !== "SAFE") return
    this._entries.set(patternKey, {
      verdict,
      expiresAt: this._now() + ttlMs,
    })
  }

  /** Number of unexpired entries currently held (primarily for testing). */
  get size(): number {
    const now = this._now()
    let count = 0
    for (const [key, entry] of this._entries) {
      if (now < entry.expiresAt) {
        count++
      } else {
        this._entries.delete(key)
      }
    }
    return count
  }
}
