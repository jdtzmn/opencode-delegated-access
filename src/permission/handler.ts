import type { createOpencodeClient, Permission } from "@opencode-ai/sdk"
import type { DelegatedAccessConfig } from "../config.ts"
import { getLastUserMessages } from "../ui/messages.ts"
import { classifyCommand } from "../classifier/classify.ts"
import { resolveClassifierModel, type ModelRef } from "../classifier/model.ts"
import { runSafePath } from "./safe-path.ts"
import { runRiskyPathInBackground } from "./risky-path.ts"

type OpencodeClient = ReturnType<typeof createOpencodeClient>

/**
 * Permission types that our plugin classifies. For v1, bash only.
 *
 * OpenCode's `Permission.type` is `string` (no enum in the SDK), so we match
 * defensively. Different tool names observed in practice are listed below;
 * additional synonyms can be added if opencode versions diverge.
 */
const BASH_TYPE_MATCHES = new Set(["bash", "command"])

export type HandlerContext = {
  client: OpencodeClient
  config: DelegatedAccessConfig
  /**
   * The session's currently-configured model, used to pick a small default
   * classifier model when `config.classifierModel` is not set. `undefined` is
   * allowed (we just fall back to config-override only).
   */
  sessionModel: ModelRef | undefined
  /**
   * Track IDs of ephemeral classifier sessions we create. Used by the plugin
   * entry as a loop-guard: if a `permission.asked` event's sessionID is in
   * this set, the plugin skips it (defense-in-depth — the classifier uses
   * `tools: {}` and shouldn't generate permissions, but we guard anyway).
   */
  ephemeralSessionIDs: Set<string>
}

/**
 * React to a single `permission.asked` event.
 *
 * opencode 1.4.x does not dispatch the `permission.ask` hook declared in the
 * plugin SDK types — its runtime emits the `permission.asked` event AFTER a
 * permission has already been queued and the TUI prompt has started
 * displaying. To intercept, we listen to this event and use
 * `client.postSessionIdPermissionsPermissionId` to resolve the permission
 * programmatically. This dismisses the TUI prompt and lets the command
 * proceed (or denies it).
 *
 * Consequence: the TUI prompt BRIEFLY appears for SAFE commands before being
 * auto-dismissed. This is a limitation of the runtime, not the design. See
 * the design spec for rationale.
 *
 * Flow:
 *   - Disabled / non-bash type / no command → do nothing (TUI prompt stays,
 *     user decides manually).
 *   - Classifier failure → same.
 *   - SAFE → countdown notification; on "allow" outcome, call SDK with
 *     `response: "once"` to auto-approve.
 *   - RISKY → kick off risky-path notification (Approve/Reject buttons);
 *     button clicks resolve the permission via the SDK.
 *
 * Returns when all SAFE-path awaited work is done; RISKY-path work is
 * fire-and-forget.
 */
export async function handlePermissionEvent(
  permission: Permission,
  ctx: HandlerContext,
): Promise<void> {
  // Disabled → let opencode's normal approval machinery handle it.
  if (!ctx.config.enabled) return

  // Non-bash → outside v1 scope.
  if (!BASH_TYPE_MATCHES.has(permission.type)) return

  // Extract the command. `pattern` can be string or array (or missing).
  const command = extractCommand(permission.pattern)
  if (command === null) return

  // Resolve classifier model (config override → provider default → session
  // model → null).
  const model = resolveClassifierModel({
    configOverride: ctx.config.classifierModel,
    sessionModel: ctx.sessionModel,
  })
  if (!model) return

  // Fetch the last K user messages for the classifier's context.
  let userMessages: string[]
  try {
    userMessages = await getLastUserMessages(
      ctx.client,
      permission.sessionID,
      ctx.config.contextMessageCount,
    )
  } catch {
    return
  }

  // Run the classifier. Track the ephemeral session ID in the loop-guard
  // set so that if the classifier somehow generates its own permission
  // events (it shouldn't, since tools are disabled), the plugin entry can
  // skip them.
  const verdict = await classifyCommand({
    client: ctx.client,
    command,
    userMessages,
    parentSessionID: permission.sessionID,
    model,
    timeoutMs: ctx.config.classifierTimeoutMs,
    onEphemeralSessionCreated: (id) => ctx.ephemeralSessionIDs.add(id),
    onEphemeralSessionDeleted: (id) => ctx.ephemeralSessionIDs.delete(id),
  })

  if (!verdict) return // fail closed: TUI prompt remains, user decides

  if (verdict.verdict === "SAFE") {
    const decision = await runSafePath({
      command,
      reason: verdict.reason,
      countdownMs: ctx.config.safeCountdownMs,
      sound: ctx.config.notificationSound,
    })
    if (decision === "allow") {
      await respondToPermission(ctx.client, permission, "once")
    }
    // decision === "ask" → do nothing; TUI prompt is already there.
    return
  }

  // RISKY: kick off the notification with Approve/Reject buttons. The
  // notification resolves via the SDK on button click; if the user
  // answers in the TUI first, the notification is a no-op.
  void runRiskyPathInBackground({
    client: ctx.client,
    sessionID: permission.sessionID,
    permissionID: permission.id,
    command,
    reason: verdict.reason,
    sound: ctx.config.notificationSound,
    timeoutSec: 60,
  })
}

/**
 * Call opencode's permission-respond endpoint. Swallows errors — if the
 * response fails, the TUI prompt remains as a fallback for the user.
 */
async function respondToPermission(
  client: OpencodeClient,
  permission: Permission,
  response: "once" | "always" | "reject",
): Promise<void> {
  try {
    await (
      client as unknown as {
        postSessionIdPermissionsPermissionId: (opts: {
          path: { id: string; permissionID: string }
          body: { response: "once" | "always" | "reject" }
        }) => Promise<unknown>
      }
    ).postSessionIdPermissionsPermissionId({
      path: { id: permission.sessionID, permissionID: permission.id },
      body: { response },
    })
  } catch {
    // TUI prompt still live as fallback.
  }
}

/**
 * Coerce OpenCode's `Permission.pattern` (string | string[] | undefined) into
 * a single command string. Returns `null` when no usable command is present.
 */
function extractCommand(
  pattern: Permission["pattern"] | undefined,
): string | null {
  if (typeof pattern === "string") {
    return pattern.length > 0 ? pattern : null
  }
  if (Array.isArray(pattern) && pattern.length > 0) {
    const first = pattern[0]
    if (typeof first === "string" && first.length > 0) return first
  }
  return null
}
