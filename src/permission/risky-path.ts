import type { createOpencodeClient } from "@opencode-ai/sdk"
import { sendNotification } from "../notify/notify.ts"

type OpencodeClient = ReturnType<typeof createOpencodeClient>

/** Upper bound on the command string we embed in the notification body. */
const COMMAND_DISPLAY_MAX = 180

/** Button labels used for the RISKY notification. */
const APPROVE_LABEL = "Approve"
const REJECT_LABEL = "Reject"

/**
 * Drive the RISKY-path notification _in the background_, alongside opencode's
 * normal TUI permission prompt.
 *
 * Called AFTER the plugin's `permission.ask` hook has already resolved with
 * `output.status = "ask"`, so opencode is already showing its in-TUI prompt.
 * This function fires and awaits the notification independently:
 *
 *   - If the user clicks **Approve** in the notification, we call the SDK to
 *     resolve the permission with `response: "once"` — this closes the TUI
 *     prompt programmatically and opencode proceeds with the command.
 *   - If they click **Reject**, we call the SDK with `response: "reject"` —
 *     same deal, but opencode blocks the command.
 *   - Any other outcome (timeout, cancel, body click, notifier error, unknown
 *     action label) is a no-op: the TUI prompt is still live and the user
 *     can respond there as normal.
 *
 * SDK errors are swallowed — the TUI prompt remains as a fallback, so a
 * transient SDK failure doesn't leave the user stranded.
 *
 * This function is expected to be called with fire-and-forget semantics; it
 * never returns anything useful and never throws.
 */
export async function runRiskyPathInBackground(args: {
  client: OpencodeClient
  sessionID: string
  permissionID: string
  command: string
  reason: string
  sound: boolean
  timeoutSec: number
}): Promise<void> {
  const { client, sessionID, permissionID, command, reason, sound, timeoutSec } =
    args

  const displayCmd =
    command.length > COMMAND_DISPLAY_MAX
      ? command.slice(0, COMMAND_DISPLAY_MAX) + "…"
      : command

  const displayReason = reason.length > 0 ? ` (${reason})` : ""

  const result = await sendNotification({
    title: "delegated-access: review risky command",
    message: `${displayCmd}${displayReason}`,
    actions: [APPROVE_LABEL, REJECT_LABEL],
    sound,
    timeoutSec,
  })

  if (result.type !== "action") return

  let response: "once" | "reject" | undefined
  if (result.label === APPROVE_LABEL) response = "once"
  else if (result.label === REJECT_LABEL) response = "reject"
  if (!response) return

  try {
    // Resolve the permission programmatically; this closes the TUI prompt.
    await (
      client as unknown as {
        postSessionIdPermissionsPermissionId: (opts: {
          path: { id: string; permissionID: string }
          body: { response: "once" | "always" | "reject" }
        }) => Promise<unknown>
      }
    ).postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID },
      body: { response },
    })
  } catch {
    // Swallow — TUI prompt is still live as a fallback.
  }
}
