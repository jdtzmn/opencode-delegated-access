import { sendNotification } from "../notify/notify.ts"
import type { Logger } from "../log.ts"

/** The decision returned to the permission.ask hook. */
export type SafePathOutcome = "allow" | "ask"

/** Upper bound on the command string we embed in the notification body. */
const COMMAND_DISPLAY_MAX = 180

/**
 * Drive the SAFE-path UX: post a cancellable OS notification and wait for
 * either the countdown to expire (→ `"allow"`) or the user to interact with
 * it (→ `"ask"`, so opencode falls back to its normal approval prompt).
 *
 * The notification itself is our countdown timer: `node-notifier` gives us a
 * `timeout` in seconds that expires the notification exactly when we want
 * the auto-approve to fire. Any user interaction (Cancel button, body click,
 * or explicit dismiss) resolves the notification before the timeout and we
 * escalate to `"ask"`.
 *
 * When `countdownMs` is 0, we skip the notification entirely and auto-allow
 * silently (opt-in for users who find even a passive notification too
 * noisy).
 *
 * Platform-level notifier failures (e.g. no display) resolve as `"allow"`:
 * the classifier already deemed the command SAFE, and we don't want a broken
 * notifier to block otherwise-approved commands. The RISKY path uses a
 * different fail-mode since a RISKY command _does_ need user review.
 *
 * Diagnostic logs fire before the notification is scheduled and after it
 * resolves. These are deliberately placed so that grepping
 * `service=delegated-access` in the opencode log reveals which branch of
 * the switch actually ran — the 2026-04-18 investigation revealed a silent
 * `type: "error"` fall-through that looked indistinguishable from a
 * working auto-approve in the log.
 */
export async function runSafePath(args: {
  command: string
  reason: string
  countdownMs: number
  sound: boolean
  /** Optional logger; when omitted (e.g. from unit tests) no logs are emitted. */
  log?: Logger
}): Promise<SafePathOutcome> {
  const { command, countdownMs, sound, log } = args

  if (countdownMs <= 0) {
    log?.info("safe-path: silent instant-allow", { countdownMs })
    return "allow"
  }

  const timeoutSec = Math.max(1, Math.ceil(countdownMs / 1000))

  const displayCmd =
    command.length > COMMAND_DISPLAY_MAX
      ? command.slice(0, COMMAND_DISPLAY_MAX) + "…"
      : command

  log?.info("safe-path: scheduling notification", {
    countdownMs,
    timeoutSec,
    sound,
  })

  const result = await sendNotification({
    title: "delegated-access: auto-approving",
    message: `Running in ${timeoutSec}s: ${displayCmd}`,
    actions: ["Cancel"],
    sound,
    timeoutSec,
  })

  // Log the raw notification outcome before mapping to allow/ask. When
  // `node-notifier` fails (binary missing, Notification Center denied, OS
  // unsupported, &c.) we fall through to `"allow"` — which is intentional
  // fail-open on the SAFE path — but it's indistinguishable in the log from
  // a healthy countdown without this line.
  const logResult: Record<string, unknown> = { resultType: result.type }
  if (result.type === "action") logResult.label = result.label
  if (result.type === "error") logResult.error = result.error.message
  log?.info("safe-path: notification resolved", logResult)

  switch (result.type) {
    case "timeout":
      return "allow"
    case "action":
    case "cancel":
    case "click":
      return "ask"
    case "error":
      // Notifier-level failure — classifier already said SAFE; don't block.
      return "allow"
  }
}
