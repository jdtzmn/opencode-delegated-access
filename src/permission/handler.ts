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

const LOG_PREFIX = "[delegated-access]"

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
 * Output object shape for the `permission.ask` hook. If provided, setting
 * `.status = "allow"` here auto-approves the permission BEFORE opencode
 * shows its TUI prompt (true pre-ask interception).
 *
 * For the `event` and `"permission.updated"` hooks the permission has
 * already been queued and the TUI prompt is already on-screen — in those
 * cases `output` is undefined and we resolve via the SDK respond endpoint.
 */
export type HandlerOutput = { status: "ask" | "deny" | "allow" }

/**
 * React to a permission request from opencode.
 *
 * This function is dispatched from three possible hooks for compatibility:
 *
 *   - `permission.ask` (typed in SDK; rarely dispatched by the 1.4.x runtime
 *     today — we register it defensively for forward-compat). When fired
 *     with `output`, setting `output.status = "allow"` pre-empts the TUI
 *     prompt entirely — no flash.
 *   - `permission.updated` (fires reliably on 1.4.x; what notification.js
 *     uses). No `output`; we resolve via the SDK respond endpoint after the
 *     TUI prompt is already showing. User sees a brief flash.
 *   - `event` hook filtered to `permission.asked` / `permission.updated`
 *     types (belt-and-suspenders). Same as `permission.updated` semantics.
 *
 * Shared dedupe (via `ctx`'s caller) ensures each permissionID is handled
 * exactly once regardless of how many hooks fire for it.
 *
 * Flow:
 *   - Disabled / non-bash type / no command / no model → do nothing (TUI
 *     prompt stays, user decides manually).
 *   - Classifier failure → same.
 *   - SAFE → countdown notification; on "allow" outcome, set
 *     `output.status` (if available) OR call the SDK respond endpoint.
 *   - RISKY → kick off risky-path notification (Approve/Reject buttons);
 *     button clicks resolve the permission via the SDK.
 */
export async function handlePermissionEvent(
  permission: Permission,
  ctx: HandlerContext,
  opts: { hookName: string; output?: HandlerOutput } = { hookName: "unknown" },
): Promise<void> {
  const { hookName, output } = opts

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

  console.error(
    `${LOG_PREFIX} classifying via ${hookName} cmd=${JSON.stringify(command)}`,
  )

  // Fetch the last K user messages for the classifier's context.
  let userMessages: string[]
  try {
    userMessages = await getLastUserMessages(
      ctx.client,
      permission.sessionID,
      ctx.config.contextMessageCount,
    )
  } catch (e) {
    console.error(
      `${LOG_PREFIX} getLastUserMessages failed: ${e instanceof Error ? e.message : String(e)}`,
    )
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

  if (!verdict) {
    console.error(`${LOG_PREFIX} classifier failed; leaving TUI prompt alone`)
    return // fail closed: TUI prompt remains, user decides
  }

  console.error(
    `${LOG_PREFIX} verdict=${verdict.verdict} reason=${JSON.stringify(verdict.reason)}`,
  )

  if (verdict.verdict === "SAFE") {
    const decision = await runSafePath({
      command,
      reason: verdict.reason,
      countdownMs: ctx.config.safeCountdownMs,
      sound: ctx.config.notificationSound,
    })
    if (decision === "allow") {
      console.error(`${LOG_PREFIX} auto-approving ${JSON.stringify(command)}`)
      // Prefer pre-ask output mutation when the hook supports it (avoids
      // the TUI flash); otherwise fall back to the SDK respond endpoint.
      if (output) {
        output.status = "allow"
      } else {
        await respondToPermission(ctx.client, permission, "once")
      }
    } else {
      console.error(
        `${LOG_PREFIX} user cancelled auto-approval; TUI prompt remains`,
      )
    }
    return
  }

  // RISKY: kick off the notification with Approve/Reject buttons. The
  // notification resolves via the SDK on button click; if the user
  // answers in the TUI first, the notification is a no-op.
  //
  // For the pre-ask (permission.ask) hook path, we explicitly leave
  // output.status as-is ("ask") so opencode proceeds to show the normal
  // TUI prompt — the notification runs alongside it.
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
  } catch (e) {
    // TUI prompt still live as fallback.
    console.error(
      `${LOG_PREFIX} respondToPermission failed: ${e instanceof Error ? e.message : String(e)}`,
    )
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
