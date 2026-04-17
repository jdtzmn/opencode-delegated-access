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
}

/**
 * Top-level orchestration for `permission.ask`. Mutates `output.status`
 * according to the classifier verdict and dispatches the SAFE or RISKY
 * UX path.
 *
 * Returns when `output.status` has been set to its final value. In the
 * RISKY path the notification-driven SDK response runs in the background
 * after this function returns (because once the hook resolves opencode
 * shows its TUI prompt, and the notification resolves the permission
 * programmatically from the outside).
 */
export async function handlePermission(
  input: Permission,
  output: { status: "ask" | "deny" | "allow" },
  ctx: HandlerContext,
): Promise<void> {
  // Disabled → pass through to opencode's normal approval machinery.
  if (!ctx.config.enabled) return

  // Non-bash → outside v1 scope.
  if (!BASH_TYPE_MATCHES.has(input.type)) return

  // Extract the command. `pattern` can be string or array (or missing).
  const command = extractCommand(input.pattern)
  if (command === null) {
    // No command to classify — fail closed.
    output.status = "ask"
    return
  }

  // Resolve classifier model (config override → provider default → session
  // model → null).
  const model = resolveClassifierModel({
    configOverride: ctx.config.classifierModel,
    sessionModel: ctx.sessionModel,
  })
  if (!model) {
    output.status = "ask"
    return
  }

  // Fetch the last K user messages for the classifier's context.
  let userMessages: string[]
  try {
    userMessages = await getLastUserMessages(
      ctx.client,
      input.sessionID,
      ctx.config.contextMessageCount,
    )
  } catch {
    output.status = "ask"
    return
  }

  // Run the classifier.
  const verdict = await classifyCommand({
    client: ctx.client,
    command,
    userMessages,
    parentSessionID: input.sessionID,
    model,
    timeoutMs: ctx.config.classifierTimeoutMs,
  })

  if (!verdict) {
    // Classifier failure → fail closed.
    output.status = "ask"
    return
  }

  if (verdict.verdict === "SAFE") {
    const decision = await runSafePath({
      command,
      reason: verdict.reason,
      countdownMs: ctx.config.safeCountdownMs,
      sound: ctx.config.notificationSound,
    })
    output.status = decision
    return
  }

  // RISKY: set ask and kick off the notification-driven resolution.
  output.status = "ask"
  void runRiskyPathInBackground({
    client: ctx.client,
    sessionID: input.sessionID,
    permissionID: input.id,
    command,
    reason: verdict.reason,
    sound: ctx.config.notificationSound,
    timeoutSec: 60,
  })
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
