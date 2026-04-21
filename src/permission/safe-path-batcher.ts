import type { NotifyArgs, NotifyActionResult } from "../notify/notify.ts"
import type { SafePathOutcome } from "./safe-path.ts"
import type { Logger } from "../log.ts"

/** Upper bound on the subject string embedded in the notification body. */
const SUBJECT_DISPLAY_MAX = 140

type PendingItem = {
  subject: string
  resolve: (outcome: SafePathOutcome) => void
}

/**
 * Batches concurrent {@link SafePathOutcome} decisions into a single macOS
 * notification.
 *
 * ## Why this exists
 *
 * macOS NotificationCenter only keeps one `terminal-notifier` process alive
 * at a time. When the plugin posts a second notification while the first is
 * still waiting for the user, the OS dismisses the first — node-notifier
 * reports that as `activationType: "closed"` → `resultType: cancel`. The
 * plugin then (correctly) interprets that as "user cancelled" and leaves the
 * TUI prompt open.
 *
 * In practice, an agent exploring an external repository issues several
 * `external_directory` permission requests within milliseconds of each other.
 * Without batching, N-1 of them would be "cancelled" by the OS every time.
 *
 * ## How it works
 *
 * When the first `enqueue` call arrives, a timer is started for
 * `batchWindowMs` (default 200 ms). Any further `enqueue` calls within that
 * window are collected. When the timer fires, a single notification is posted
 * on behalf of all collected items. All items in the batch receive the same
 * outcome — if the user cancels, every TUI prompt in the batch remains open.
 *
 * A new batch starts independently after the current one is flushed.
 *
 * ## countdownMs: 0 shortcut
 *
 * When `countdownMs` is zero the caller wants a silent instant-allow. Enqueue
 * returns `"allow"` immediately without starting a timer or posting a
 * notification.
 */
export class SafePathBatcher {
  /** Injectable `sendNotification` — makes unit-testing possible without OS calls. */
  readonly sendNotification: (args: NotifyArgs) => Promise<NotifyActionResult>

  private readonly batchWindowMs: number
  private readonly countdownMs: number
  private readonly sound: boolean
  private readonly log?: Logger

  private pending: PendingItem[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(args: {
    batchWindowMs: number
    sendNotification: (args: NotifyArgs) => Promise<NotifyActionResult>
    countdownMs: number
    sound: boolean
    log?: Logger
  }) {
    this.batchWindowMs = args.batchWindowMs
    this.sendNotification = args.sendNotification
    this.countdownMs = args.countdownMs
    this.sound = args.sound
    this.log = args.log
  }

  /**
   * Add `subject` to the current batch and return a Promise that resolves
   * with the outcome once the batch notification settles.
   *
   * If `countdownMs` is 0, resolves immediately as `"allow"` with no
   * notification.
   */
  enqueue(subject: string): Promise<SafePathOutcome> {
    if (this.countdownMs <= 0) {
      return Promise.resolve("allow")
    }

    return new Promise<SafePathOutcome>((resolve) => {
      this.pending.push({ subject, resolve })

      if (this.timer === null) {
        this.timer = setTimeout(() => this.flush(), this.batchWindowMs)
      }
    })
  }

  /** Fire the notification for the current batch and resolve all pending items. */
  private flush(): void {
    this.timer = null

    const items = this.pending.splice(0) // drain
    if (items.length === 0) return

    const timeoutSec = Math.max(1, Math.ceil(this.countdownMs / 1000))
    const message = this.buildMessage(items, timeoutSec)

    this.log?.info("safe-path batcher: flushing batch", {
      batchSize: items.length,
      timeoutSec,
    })

    this.sendNotification({
      title: "delegated-access: auto-approving",
      message,
      actions: ["Cancel"],
      sound: this.sound,
      timeoutSec,
    })
      .then((result) => {
        this.log?.info("safe-path batcher: notification resolved", {
          resultType: result.type,
          batchSize: items.length,
          ...(result.type === "action" ? { label: result.label } : {}),
          ...(result.type === "error" ? { error: result.error.message } : {}),
        })

        const outcome = this.outcomeFromResult(result)
        for (const item of items) {
          item.resolve(outcome)
        }
      })
      .catch(() => {
        // sendNotification never rejects (returns error variant instead), but
        // be defensive — resolve all as allow so we don't leave TUI prompts
        // hanging forever.
        for (const item of items) {
          item.resolve("allow")
        }
      })
  }

  private buildMessage(items: PendingItem[], timeoutSec: number): string {
    const first = items[0]!.subject
    const displaySubject =
      first.length > SUBJECT_DISPLAY_MAX
        ? first.slice(0, SUBJECT_DISPLAY_MAX) + "…"
        : first

    const extra = items.length > 1 ? ` (+${items.length - 1} more)` : ""
    return `Running in ${timeoutSec}s: ${displaySubject}${extra}`
  }

  private outcomeFromResult(result: NotifyActionResult): SafePathOutcome {
    switch (result.type) {
      case "timeout":
        return "allow"
      case "action":
      case "cancel":
      case "click":
        return "ask"
      case "error":
        // Notifier failure — classifier already said SAFE, don't block.
        return "allow"
    }
  }
}
