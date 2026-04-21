import type { createOpencodeClient, Permission } from "@opencode-ai/sdk"
import type { DelegatedAccessConfig } from "../config.ts"
import {
  extractLastUserMessages,
  extractLatestAssistantModel,
  extractRootAgent,
  getSessionMessages,
} from "../ui/messages.ts"
import {
  classifyCommand,
  classifySubject,
} from "../classifier/classify.ts"
import { resolveClassifierModel, type ModelRef } from "../classifier/model.ts"
import { resolveRootSessionID } from "../ui/session-tree.ts"
import {
  DIRECTORY_CLASSIFIER_SYSTEM_PROMPT,
  buildDirectoryClassifierUserPrompt,
} from "../classifier/prompt.ts"
import { DirectoryVerdictCache } from "./directory-cache.ts"
import { runSafePath } from "./safe-path.ts"
import { runRiskyPathInBackground } from "./risky-path.ts"
import type { Logger } from "../log.ts"

type OpencodeClient = ReturnType<typeof createOpencodeClient>

/**
 * Permission types that our plugin classifies for bash commands.
 *
 * OpenCode's `Permission.type` is `string` (no enum in the SDK), so we match
 * defensively. Different tool names observed in practice are listed below;
 * additional synonyms can be added if opencode versions diverge.
 */
const BASH_TYPE_MATCHES = new Set(["bash", "command"])

/** Runtime permission type string for external-directory access. */
const EXTERNAL_DIRECTORY_TYPE = "external_directory"

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
   * `tools: { "*": false }` and shouldn't generate permissions, but we guard
   * anyway).
   */
  ephemeralSessionIDs: Set<string>
  /**
   * Shared TTL cache for recent SAFE external_directory verdicts. A single
   * instance is held for the plugin's lifetime and shared across all
   * permission events so burst requests for the same path skip the LLM call.
   */
  directoryVerdictCache: DirectoryVerdictCache
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

  // Dispatch by permission type.
  if (toolType && BASH_TYPE_MATCHES.has(toolType)) {
    const command = extractCommand(patterns)
    if (command === null) {
      log.info("skip: no command in pattern", {
        ...base,
        pattern: patterns as unknown,
      })
      return
    }
    await handleSubjectPermission({
      subject: command,
      subjectLabel: "command",
      systemPrompt: null, // signals: use classifyCommand (bash-specific)
      permission,
      ctx,
      output,
      base,
    })
    return
  }

  if (toolType === EXTERNAL_DIRECTORY_TYPE) {
    if (!ctx.config.externalDirectoryEnabled) {
      log.info("skip: external_directory auto-approval disabled", base)
      return
    }
    const path = extractCommand(patterns) // same extraction logic — first pattern
    if (path === null) {
      log.info("skip: no path in external_directory pattern", {
        ...base,
        pattern: patterns as unknown,
      })
      return
    }
    const patternsList = Array.isArray(patterns)
      ? (patterns as string[]).filter(Boolean)
      : typeof patterns === "string" && patterns
        ? [patterns]
        : []
    await handleSubjectPermission({
      subject: path,
      subjectLabel: "path",
      systemPrompt: DIRECTORY_CLASSIFIER_SYSTEM_PROMPT,
      permission,
      ctx,
      output,
      base,
      directoryPatterns: patternsList,
    })
    return
  }

  log.info("skip: unsupported permission type", base)
}

// ---------------------------------------------------------------------------
// Shared core: classify a subject, run safe/risky path, respond to permission
// ---------------------------------------------------------------------------

/**
 * Shared classification + response flow for any permission subject (bash
 * command or directory path). The two permission types differ only in:
 *   - `subject` string (the thing being classified)
 *   - `systemPrompt` (null → use the bash-specific `classifyCommand` wrapper;
 *     non-null → use the generic `classifySubject` with the given prompt)
 *   - `directoryPatterns` (only set for directory permissions — used for the
 *     burst-deduplication cache lookup)
 */
async function handleSubjectPermission(args: {
  subject: string
  subjectLabel: string
  systemPrompt: string | null
  permission: Permission
  ctx: HandlerContext
  output: HandlerOutput | undefined
  base: Record<string, unknown>
  directoryPatterns?: string[]
}): Promise<void> {
  const {
    subject,
    subjectLabel,
    systemPrompt,
    permission,
    ctx,
    output,
    base,
    directoryPatterns,
  } = args
  const { log } = ctx

  // ---- Directory cache lookup (directories only) -------------------------
  if (directoryPatterns) {
    const cacheKey = DirectoryVerdictCache.keyFor(directoryPatterns)
    const cached = ctx.directoryVerdictCache.get(cacheKey)
    if (cached) {
      log.info("directory cache hit — skipping classifier", {
        ...base,
        [subjectLabel]: subject,
        cachedVerdict: cached.verdict.verdict,
        cachedReason: cached.verdict.reason,
      })
      // Run safe-path with the cached verdict (burst requests still get the
      // countdown; user can cancel any of them).
      await runSafeOrRiskyPath({
        verdict: cached.verdict,
        subject,
        subjectLabel,
        permission,
        ctx,
        output,
        base,
      })
      return
    }
  }

  // ---- Root-session resolution -------------------------------------------
  //
  // When a permission fires inside a subagent session, the sessionID points
  // at the subagent — whose "user" messages are the dispatching agent's
  // prompts, NOT the real human's. Walk up the parentID chain to the root.
  //
  // Fail-closed: null → TUI prompt remains, user decides manually.
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

  // ---- Message extraction ------------------------------------------------
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

  const rootAgent = extractRootAgent(entries)
  if (rootAgent === null && entries.length > 0) {
    log.warn(
      "could not identify root session's primary agent; filter skipped",
      { ...base, rootSessionID },
    )
  }

  const userMessages = extractLastUserMessages(
    entries,
    ctx.config.contextMessageCount,
    rootAgent ?? undefined,
  )
  const fallbackModel = extractLatestAssistantModel(entries)

  // ---- Classifier model --------------------------------------------------
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
    [subjectLabel]: subject,
    classifierModel: `${model.providerID}/${model.modelID}`,
    modelSource,
  })

  // ---- Classifier call ---------------------------------------------------
  const commonClassifyArgs = {
    client: ctx.client,
    userMessages,
    parentSessionID: permission.sessionID,
    model,
    timeoutMs: ctx.config.classifierTimeoutMs,
    onEphemeralSessionCreated: (id: string) =>
      ctx.ephemeralSessionIDs.add(id),
    onEphemeralSessionDeleted: (id: string) =>
      ctx.ephemeralSessionIDs.delete(id),
  }

  const verdict =
    systemPrompt === null
      ? // Bash path: use the convenience wrapper that supplies the bash prompt.
        await classifyCommand({ ...commonClassifyArgs, command: subject })
      : // Generic path (e.g. directory): caller supplies the system prompt.
        await classifySubject({
          ...commonClassifyArgs,
          subject,
          systemPrompt,
          buildUserPrompt: buildDirectoryClassifierUserPrompt,
        })

  if (!verdict) {
    log.warn("classifier failed; leaving TUI prompt alone", base)
    return
  }

  log.info("classifier verdict", {
    ...base,
    verdict: verdict.verdict,
    reason: verdict.reason,
  })

  // ---- Directory cache population (SAFE only) ----------------------------
  if (directoryPatterns && verdict.verdict === "SAFE") {
    const cacheKey = DirectoryVerdictCache.keyFor(directoryPatterns)
    ctx.directoryVerdictCache.set(
      cacheKey,
      verdict,
      ctx.config.directoryVerdictCacheTtlMs,
    )
  }

  // ---- Safe / Risky path -------------------------------------------------
  await runSafeOrRiskyPath({
    verdict,
    subject,
    subjectLabel,
    permission,
    ctx,
    output,
    base,
  })
}

// ---------------------------------------------------------------------------
// Safe / risky path execution (shared between cache-hit and fresh-verdict paths)
// ---------------------------------------------------------------------------

async function runSafeOrRiskyPath(args: {
  verdict: import("../classifier/parse.ts").Verdict
  subject: string
  subjectLabel: string
  permission: Permission
  ctx: HandlerContext
  output: HandlerOutput | undefined
  base: Record<string, unknown>
}): Promise<void> {
  const { verdict, subject, subjectLabel, permission, ctx, output, base } = args
  const { log } = ctx

  if (verdict.verdict === "SAFE") {
    log.info("entering safe-path", {
      ...base,
      countdownMs: ctx.config.safeCountdownMs,
    })
    const decision = await runSafePath({
      command: subject,
      reason: verdict.reason,
      countdownMs: ctx.config.safeCountdownMs,
      sound: ctx.config.notificationSound,
      log,
    })
    log.info("safe-path returned", { ...base, decision })
    if (decision === "allow") {
      log.info("auto-approving", {
        ...base,
        [subjectLabel]: subject,
        viaOutput: Boolean(output),
      })
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
  // RISKY: fire the notification alongside opencode's TUI prompt.
  void runRiskyPathInBackground({
    client: ctx.client,
    sessionID: permission.sessionID,
    permissionID: permission.id,
    command: subject,
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
