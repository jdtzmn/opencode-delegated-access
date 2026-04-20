import type { createOpencodeClient, Permission } from "@opencode-ai/sdk"
import type { DelegatedAccessConfig } from "../config.ts"
import {
  extractLastUserMessages,
  extractLatestAssistantModel,
  extractRootAgent,
  getSessionMessages,
} from "../ui/messages.ts"
import { classifyCommand } from "../classifier/classify.ts"
import { resolveClassifierModel, type ModelRef } from "../classifier/model.ts"
import { resolveRootSessionID } from "../ui/session-tree.ts"
import { runSafePath } from "./safe-path.ts"
import { runRiskyPathInBackground } from "./risky-path.ts"
import type { Logger } from "../log.ts"

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
  /** Logger for diagnostic output. */
  log: Logger
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
 */
export async function handlePermissionEvent(
  permission: Permission,
  ctx: HandlerContext,
  opts: { hookName: string; output?: HandlerOutput } = { hookName: "unknown" },
): Promise<void> {
  const { hookName, output } = opts
  const { log } = ctx

  // Runtime-shape adapter.
  //
  // The SDK's typed Permission declares `type: string` and `pattern: string |
  // string[]`, but the opencode 1.4.x event stream actually emits
  // `{ permission: string, patterns: string[] }` (different field names).
  // Prefer the runtime names, fall back to the SDK-typed names so both
  // shapes and our test fixtures keep working.
  const runtimeShape = permission as unknown as {
    permission?: string
    patterns?: string[]
    type?: string
    pattern?: string | string[]
  }
  const toolType = runtimeShape.permission ?? runtimeShape.type
  const patterns = runtimeShape.patterns ?? runtimeShape.pattern

  const base = {
    hook: hookName,
    permissionID: permission.id,
    permissionType: toolType,
  }

  // Disabled → let opencode's normal approval machinery handle it.
  if (!ctx.config.enabled) {
    log.info("skip: plugin disabled", base)
    return
  }

  // Non-bash → outside v1 scope.
  if (!toolType || !BASH_TYPE_MATCHES.has(toolType)) {
    log.info("skip: not a bash permission", base)
    return
  }

  // Extract the command. `patterns` / `pattern` can be string or array.
  const command = extractCommand(patterns)
  if (command === null) {
    log.info("skip: no command in pattern", {
      ...base,
      pattern: patterns as unknown,
    })
    return
  }

  // Resolve the ROOT session.
  //
  // When a bash permission fires inside a subagent session, the
  // permission's sessionID points at the subagent — whose "user" role
  // messages are actually the dispatching agent's prompts to the
  // subagent, NOT the real human's messages. Classifying against those
  // would violate the plugin's core safety property ("classifier never
  // sees the agent's messages"), so we walk up the parentID chain to
  // find the root session and pull human messages from there.
  //
  // Fail-closed: if the resolver returns null (SDK error, cycle, max
  // depth exceeded, missing payload) we abort classification and leave
  // the TUI prompt alone. The user approves manually.
  const rootSessionID = await resolveRootSessionID(
    ctx.client,
    permission.sessionID,
  )
  if (rootSessionID === null) {
    log.warn(
      "skip: could not resolve root session (fail-closed to TUI prompt)",
      base,
    )
    return
  }
  if (rootSessionID !== permission.sessionID) {
    log.info("resolved subagent to root session", {
      ...base,
      permissionSessionID: permission.sessionID,
      rootSessionID,
    })
  }

  // Fetch the ROOT session's messages once: the classifier context needs
  // the last K user messages, and we derive a session-model fallback from
  // the most recent assistant message (used when the `config` hook hasn't
  // run or didn't surface a model). Inside a subagent the root's messages
  // are the ones authored by the real human.
  let entries
  try {
    entries = await getSessionMessages(ctx.client, rootSessionID)
  } catch (e) {
    log.error("getSessionMessages failed", {
      ...base,
      error: e instanceof Error ? e.message : String(e),
    })
    return
  }

  // Defense-in-depth: anchor user-message extraction to the root
  // session's primary agent. If the root has no identifiable primary
  // agent (e.g. empty session, or first user message missing its agent
  // field), the filter is skipped and extraction falls back to its
  // plain behaviour — the root-walk itself is still the primary
  // protection against subagent confusion.
  const rootAgent = extractRootAgent(entries)
  if (rootAgent === null && entries.length > 0) {
    log.warn("could not identify root session's primary agent; filter skipped", {
      ...base,
      rootSessionID,
    })
  }

  const userMessages = extractLastUserMessages(
    entries,
    ctx.config.contextMessageCount,
    rootAgent ?? undefined,
  )
  const fallbackModel = extractLatestAssistantModel(entries)

  // Resolve classifier model (config override → provider default → session
  // model → assistant-message fallback → null).
  const model = resolveClassifierModel({
    configOverride: ctx.config.classifierModel,
    sessionModel: ctx.sessionModel ?? fallbackModel ?? undefined,
  })
  if (!model) {
    log.warn("skip: no classifier model could be resolved", {
      ...base,
      hasCtxSessionModel: Boolean(ctx.sessionModel),
      hasFallbackModel: Boolean(fallbackModel),
      hasConfigOverride: Boolean(ctx.config.classifierModel),
    })
    return
  }

  const modelSource = ctx.config.classifierModel
    ? "configOverride"
    : ctx.sessionModel
      ? "ctxSessionModel"
      : fallbackModel
        ? "latestAssistantMessage"
        : "unknown"

  log.info("classifying", {
    ...base,
    command,
    classifierModel: `${model.providerID}/${model.modelID}`,
    modelSource,
  })

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
    log.warn("classifier failed; leaving TUI prompt alone", base)
    return // fail closed: TUI prompt remains, user decides
  }

  log.info("classifier verdict", {
    ...base,
    verdict: verdict.verdict,
    reason: verdict.reason,
  })

  if (verdict.verdict === "SAFE") {
    log.info("entering safe-path", {
      ...base,
      countdownMs: ctx.config.safeCountdownMs,
    })
    const decision = await runSafePath({
      command,
      reason: verdict.reason,
      countdownMs: ctx.config.safeCountdownMs,
      sound: ctx.config.notificationSound,
      log,
    })
    log.info("safe-path returned", { ...base, decision })
    if (decision === "allow") {
      log.info("auto-approving", { ...base, command, viaOutput: Boolean(output) })
      // Prefer pre-ask output mutation when the hook supports it (avoids
      // the TUI flash); otherwise fall back to the SDK respond endpoint.
      if (output) {
        output.status = "allow"
      } else {
        await respondToPermission(ctx.client, permission, "once", log)
      }
    } else {
      log.info("user cancelled auto-approval; TUI prompt remains", base)
    }
    return
  }

  log.info("risky — escalating via TUI + notification", base)
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
  log: Logger,
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
    log.info("permission respond succeeded", {
      permissionID: permission.id,
      response,
    })
  } catch (e) {
    // TUI prompt still live as fallback.
    log.error("permission respond failed", {
      permissionID: permission.id,
      response,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * Coerce OpenCode's pattern field (string | string[] | undefined — under
 * either the SDK-typed `pattern` key or the runtime `patterns` key) into a
 * single command string. Returns `null` when no usable command is present.
 */
function extractCommand(
  pattern: string | string[] | undefined,
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
