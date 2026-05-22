/**
 * What we remember about a permission between when it first fires
 * (`permission.updated` / `permission.ask`) and when it's resolved
 * (`permission.replied`). The replied event only carries
 * `{ sessionID, permissionID, response }`, so we look up the rest by ID.
 */
export type PendingSubject = {
  /** Root session ID (walked up from the permission's own sessionID). */
  rootSessionID: string
  /** The command string or directory path being approved. */
  subject: string
  /** "command" for bash permissions, "path" for external_directory. */
  subjectLabel: "command" | "path"
  /**
   * The classifier's verdict for this permission, or `null` if the
   * classifier hasn't returned yet (e.g. the human hammered Approve in
   * the TUI before the classifier resolved).
   */
  classifierVerdict: "SAFE" | "RISKY" | null
  /** Matching reason; `null` when the verdict is unknown. */
  classifierReason: string | null
  /**
   * True when WE (the plugin) auto-approved this on the SAFE path.
   * The `permission.replied` handler uses this to filter out our own
   * approvals so the recorded history stays pure-human-signal.
   */
  autoApproved: boolean
}

export type PendingSubjectsMapOptions = {
  /**
   * How long a pending entry is kept before it's swept. The intent is
   * "long enough that even a user who walks away for an hour still gets
   * their approval captured" while bounding memory in pathological cases
   * where a `permission.replied` event never arrives (e.g. server crash).
   */
  ttlMs?: number
  /** Clock injection for deterministic tests. */
  now?: () => number
}

const DEFAULT_TTL_MS = 60 * 60 * 1_000 // 1 hour

type Stored = {
  entry: PendingSubject
  expiresAt: number
}

/**
 * Per-permission, short-lived map populated when a permission first fires
 * and drained when it's resolved. Acts as a join between the rich subject
 * data the handler sees and the bare `permissionID` the replied event
 * carries.
 *
 * All entries have a long TTL (default 1h) as a backstop in case a replied
 * event never arrives.
 */
export class PendingSubjectsMap {
  private readonly _entries = new Map<string, Stored>()
  private readonly _ttlMs: number
  private readonly _now: () => number

  constructor(options: PendingSubjectsMapOptions = {}) {
    this._ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this._now = options.now ?? Date.now
  }

  /** Insert or overwrite the entry for `permissionID`. */
  set(permissionID: string, entry: PendingSubject): void {
    this._entries.set(permissionID, {
      entry,
      expiresAt: this._now() + this._ttlMs,
    })
  }

  /**
   * Apply a transformation to the entry for `permissionID` in-place. No-op
   * when the key is missing. The new entry inherits the existing expiry
   * (the operation reflects new information about an already-pending
   * permission, not a fresh arrival).
   */
  update(
    permissionID: string,
    fn: (current: PendingSubject) => PendingSubject,
  ): void {
    const cur = this._entries.get(permissionID)
    if (!cur) return
    cur.entry = fn(cur.entry)
  }

  /**
   * Return and remove the entry for `permissionID`, or `null` if it's
   * missing or expired (expired entries are dropped on access).
   */
  take(permissionID: string): PendingSubject | null {
    const cur = this._entries.get(permissionID)
    if (!cur) return null
    this._entries.delete(permissionID)
    if (this._now() >= cur.expiresAt) return null
    return cur.entry
  }

  /** Proactively evict expired entries. */
  sweep(): void {
    const now = this._now()
    for (const [id, stored] of this._entries) {
      if (now >= stored.expiresAt) this._entries.delete(id)
    }
  }

  /** Number of unexpired entries (sweeps expired ones first). */
  get size(): number {
    this.sweep()
    return this._entries.size
  }
}
