/**
 * One human approval (or rejection) recorded in-session for use by the
 * classifier as prior-decision evidence.
 *
 * Only resolutions triggered by the human are stored. Our own SAFE
 * auto-approvals are filtered out at the call site so the history is a
 * pure human-signal log — see `PendingSubjectsMap.autoApproved` and the
 * filtering in the `permission.replied` handler.
 */
export type ApprovalEntry = {
  /** The bash command or directory pattern that was approved/rejected. */
  subject: string
  /** "command" for bash, "path" for external_directory — keeps the prompt readable. */
  subjectLabel: "command" | "path"
  /** Server-side response value from OpenCode: "once" / "always" / "reject". */
  response: "once" | "always" | "reject"
  /** What our classifier said before the human's decision (RISKY is the interesting case). */
  classifierVerdict: "SAFE" | "RISKY"
  /** One-line reason from the classifier, included in the prompt as supporting context. */
  classifierReason: string
  /** Wall-clock at the time the resolution was observed. Used for ordering only. */
  timestamp: number
}

export type ApprovalHistoryStoreOptions = {
  /**
   * Maximum entries retained per root session. Older entries are evicted
   * when the cap is reached. Default chosen so the prompt block stays
   * small and the classifier doesn't get drowned in stale signal.
   */
  maxPerSession?: number
  /**
   * Maximum number of distinct root sessions tracked at once. When
   * exceeded, the least-recently-recorded session is evicted entirely.
   * Default is generous: in practice a single user session is the
   * common case.
   */
  maxSessions?: number
}

/**
 * In-memory per-root-session log of human approval decisions.
 *
 * Scoped to the lifetime of the plugin process (i.e. one OpenCode session
 * group). Bounded by both a per-session entry cap and a global session LRU
 * so memory stays predictable in long-lived plugin processes.
 */
export class ApprovalHistoryStore {
  private readonly _maxPerSession: number
  private readonly _maxSessions: number
  /**
   * Map preserves insertion order; we rely on that for the LRU sweep. On
   * `record`, the touched key is re-inserted at the end so it becomes the
   * most-recently-used.
   */
  private readonly _entries = new Map<string, ApprovalEntry[]>()

  constructor(options: ApprovalHistoryStoreOptions = {}) {
    this._maxPerSession = options.maxPerSession ?? 20
    this._maxSessions = options.maxSessions ?? 32
  }

  /**
   * Append a new entry for `rootSessionID`. If the per-session cap is
   * exceeded, drops the oldest entry. If the global session cap is
   * exceeded, evicts the least-recently-recorded session.
   */
  record(rootSessionID: string, entry: ApprovalEntry): void {
    let list = this._entries.get(rootSessionID)
    if (list) {
      // Touch: move this session to most-recently-used position.
      this._entries.delete(rootSessionID)
    } else {
      list = []
    }
    list.push(entry)
    if (list.length > this._maxPerSession) {
      // Drop oldest from the front to enforce the cap.
      list.splice(0, list.length - this._maxPerSession)
    }
    this._entries.set(rootSessionID, list)

    // Enforce global session cap by evicting the LRU (first inserted).
    while (this._entries.size > this._maxSessions) {
      const lru = this._entries.keys().next().value as string | undefined
      if (lru === undefined) break
      this._entries.delete(lru)
    }
  }

  /**
   * Return the most recent up to `count` entries for `rootSessionID`,
   * newest first. Empty array when the session is unknown or `count <= 0`.
   */
  recent(rootSessionID: string, count: number): ApprovalEntry[] {
    if (count <= 0) return []
    const list = this._entries.get(rootSessionID)
    if (!list || list.length === 0) return []
    // Newest first; cap to requested count.
    const slice = list.slice(-count)
    slice.reverse()
    return slice
  }
}
