import type { createOpencodeClient } from "@opencode-ai/sdk"
import {
  sendNotification as defaultSendNotification,
  type NotifyActionResult,
} from "../notify/notify.ts"
import type { ClassifyFailureClass } from "../classifier/classify.ts"

type OpencodeClient = ReturnType<typeof createOpencodeClient>

/** Upper bound on the command string we embed in the notification body. */
const COMMAND_DISPLAY_MAX = 160

/**
 * The single action offered on a classifier-failure notification.
 *
 * Deliberately Reject-ONLY: a classifier failure means we have NO verdict, so
 * we must never offer a one-click Approve on an unclassified command — that
 * would quietly defeat the plugin's core safety guarantee. Reject is fine
 * (you can kill an unknown command), and the OpenCode TUI prompt is always
 * still shown as the place to approve if you actually want to.
 */
const REJECT_LABEL = "Reject"

/**
 * Decision returned by {@link FailureNotifyRateLimiter.register}.
 */
export type RateLimitDecision = {
  /** Whether a notification should actually fire for this failure. */
  notify: boolean
  /**
   * When `notify` is true, how many earlier failures were SUPPRESSED since
   * the last allowed notification — so the caller can collapse a burst into
   * a single "(+N)" notification. Always 0 when `notify` is false.
   */
  suppressedCount: number
}

/**
 * Rate-limits classifier-failure notifications so a sustained outage produces
 * ONE notification (plus a collapsed count) instead of spamming the user with
 * a notification per failed permission.
 *
 * Stateful and plugin-lifetime-scoped (one instance shared across all
 * permission events). Pure given an injected clock — callers pass `now` so
 * tests are deterministic; production passes `Date.now()`.
 */
export class FailureNotifyRateLimiter {
  private readonly _cooldownMs: number
  private _lastNotifyAt: number | null = null
  private _suppressedSinceLast = 0

  constructor(opts: { cooldownMs: number }) {
    this._cooldownMs = Math.max(0, opts.cooldownMs)
  }

  /**
   * Record a failure occurring at wall-clock time `now` and decide whether to
   * notify. The first failure (and any failure more than `cooldownMs` after
   * the last allowed one) notifies; failures within the window are suppressed
   * and counted. `cooldownMs === 0` disables suppression entirely.
   */
  register(_failureClass: ClassifyFailureClass, now: number): RateLimitDecision {
    if (this._cooldownMs === 0) {
      return { notify: true, suppressedCount: 0 }
    }
    if (
      this._lastNotifyAt === null ||
      now - this._lastNotifyAt >= this._cooldownMs
    ) {
      const suppressed = this._suppressedSinceLast
      this._lastNotifyAt = now
      this._suppressedSinceLast = 0
      return { notify: true, suppressedCount: suppressed }
    }
    this._suppressedSinceLast++
    return { notify: false, suppressedCount: 0 }
  }
}

/**
 * Fire an informational classifier-failure notification (Reject-only) and, if
 * the user clicks Reject, resolve the permission as `reject` via the SDK.
 *
 * Fire-and-forget: never throws, never returns anything useful. The OpenCode
 * TUI prompt is always shown alongside this, so any non-Reject outcome
 * (timeout, cancel, body click, notifier error) is a no-op and the user can
 * still decide in the TUI.
 */
export async function runFailureNotificationInBackground(args: {
  client: OpencodeClient
  sessionID: string
  permissionID: string
  command: string
  failureClass: ClassifyFailureClass
  /** How many earlier failures collapsed into this one (0 = none). */
  suppressedCount: number
  sound: boolean
  timeoutSec: number
  /** Injectable for tests; defaults to the real OS notifier. */
  sendNotification?: (args: {
    title: string
    message: string
    actions?: string[]
    sound?: boolean
    timeoutSec?: number
  }) => Promise<NotifyActionResult>
}): Promise<void> {
  const {
    client,
    sessionID,
    permissionID,
    command,
    failureClass,
    suppressedCount,
    sound,
    timeoutSec,
  } = args
  const sendNotification = args.sendNotification ?? defaultSendNotification

  const displayCmd =
    command.length > COMMAND_DISPLAY_MAX
      ? command.slice(0, COMMAND_DISPLAY_MAX) + "…"
      : command

  const classLabel =
    failureClass === "timeout" ? "classifier timed out" : "classifier error"

  // When a burst was collapsed, surface the total count so the user knows it
  // was more than a one-off.
  const totalFailures = suppressedCount + 1
  const burstSuffix =
    suppressedCount > 0 ? ` (${totalFailures} recent failures)` : ""

  const result = await sendNotification({
    title: `delegated-access: ${classLabel} — review in TUI`,
    message: `${displayCmd}${burstSuffix}`,
    actions: [REJECT_LABEL],
    sound,
    timeoutSec,
  })

  if (result.type !== "action" || result.label !== REJECT_LABEL) return

  try {
    await (
      client as unknown as {
        postSessionIdPermissionsPermissionId: (opts: {
          path: { id: string; permissionID: string }
          body: { response: "once" | "always" | "reject" }
        }) => Promise<unknown>
      }
    ).postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID },
      body: { response: "reject" },
    })
  } catch {
    // Swallow — TUI prompt is still live as a fallback.
  }
}
