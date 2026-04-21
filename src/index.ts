import type { Plugin } from "@opencode-ai/plugin"
import type { Permission } from "@opencode-ai/sdk"
import { parseConfig, type DelegatedAccessConfig } from "./config.ts"
import {
  handlePermissionEvent,
  type HandlerContext,
  type HandlerOutput,
} from "./permission/handler.ts"
import { DirectoryVerdictCache } from "./permission/directory-cache.ts"
import { SafePathBatcher } from "./permission/safe-path-batcher.ts"
import { sendNotification } from "./notify/notify.ts"
import type { ModelRef } from "./classifier/model.ts"
import { createLogger, type Logger } from "./log.ts"

/**
 * OpenCode plugin entry point.
 *
 * We register THREE permission-related hooks as a "shotgun" strategy for
 * maximum compatibility with opencode's evolving plugin runtime:
 *
 *   1. `permission.ask` — typed in the SDK. If opencode dispatches it,
 *      this hook gets `output.status` and can pre-empt the TUI prompt
 *      entirely (no flash). Forward-compat for future opencode releases.
 *   2. `permission.updated` — the hook notification.js uses successfully
 *      on 1.4.x. Fires reliably after the TUI prompt is already shown.
 *   3. `event` filtered to `permission.asked` / `permission.updated` —
 *      belt-and-suspenders in case the above two both fail to dispatch.
 *
 * A shared `handledPermissionIDs` set dedupes across all three hooks so
 * each permission is classified exactly once regardless of how many hooks
 * fire for it.
 *
 * All diagnostic output goes through `client.app.log` (service
 * `delegated-access`). Grep the opencode log file to see it:
 *
 *     grep service=delegated-access ~/.local/share/opencode/log/*.log
 *
 * This bypasses the TUI prompt-bar sink that otherwise hides plugin
 * console output behind permission UIs.
 *
 * Plugin config: opencode.json → top-level `delegatedAccess` object. Any
 * shape mismatch is ignored; defaults fill in.
 */
const DelegatedAccess: Plugin = async ({ client }) => {
  const log: Logger = createLogger(client)
  log.info("plugin loaded")

  // Config is resolved lazily — we receive the full config blob via the
  // `config` hook and latch the plugin-specific subsection. Defaults take
  // over until the first `config` call or if the user never sets any.
  let config: DelegatedAccessConfig = parseConfig(undefined)

  // The session's default model, resolved from opencode's Config. Updated
  // on every `config` call so it stays in sync when the user changes models.
  let sessionModel: ModelRef | undefined

  // Track IDs of ephemeral classifier sessions we create. All permission
  // hooks skip events whose `sessionID` is in this set, so the classifier
  // can't trigger itself (defense-in-depth — the classifier runs with
  // `tools: { "*": false }` and shouldn't request permissions).
  const ephemeralSessionIDs = new Set<string>()

  // Shared TTL cache for recent SAFE external_directory verdicts. Held at
  // plugin lifetime (not per-session) so burst deduplication works across
  // rapid-fire permission events on the same session.
  const directoryVerdictCache = new DirectoryVerdictCache()

  // Shared batcher for SAFE-path notifications. A single instance means all
  // concurrent permission events funnel through the same 200ms batch window,
  // so bursts (e.g. agent accessing 3 sub-directories at once) produce one
  // macOS notification instead of N notifications that cancel each other.
  //
  // The batcher is constructed lazily-ish here with the initial config
  // defaults. If the user changes safeCountdownMs or notificationSound mid-
  // session via the config hook, the batcher won't pick that up automatically.
  // In practice both fields are set at startup and never change, so this is
  // fine. If dynamic reconfig ever becomes necessary, the batcher can be
  // recreated in the config hook.
  const safePathBatcher = new SafePathBatcher({
    batchWindowMs: 200,
    sendNotification,
    countdownMs: config.safeCountdownMs,
    sound: config.notificationSound,
    log,
  })

  // Permissions we've already handled, shared across all three hooks so
  // each permissionID is classified once no matter which hook(s) fire.
  const handledPermissionIDs = new Set<string>()

  // Upper bound on the dedupe set so it can't grow unbounded in a long
  // session. When we exceed this, prune half the entries (oldest first).
  const MAX_HANDLED = 1024

  function rememberHandled(permissionID: string) {
    handledPermissionIDs.add(permissionID)
    if (handledPermissionIDs.size > MAX_HANDLED) {
      const toRemove = Math.floor(MAX_HANDLED / 2)
      let i = 0
      for (const id of handledPermissionIDs) {
        if (i >= toRemove) break
        handledPermissionIDs.delete(id)
        i++
      }
    }
  }

  function buildCtx(): HandlerContext {
    return {
      client,
      config,
      sessionModel,
      ephemeralSessionIDs,
      directoryVerdictCache,
      safePathBatcher,
      log,
    }
  }

  /**
   * Common dispatch: validate the permission, dedupe, log, call the
   * handler. All three hook paths share this flow.
   */
  async function dispatch(
    hookName: string,
    permission: Permission | undefined | null,
    output?: HandlerOutput,
  ): Promise<void> {
    if (!permission || typeof permission.id !== "string") {
      // Nothing to process — some hook-input shapes may not carry a full
      // Permission. Silently return; other hooks will cover it.
      return
    }

    // Loop-guard: skip events from our own ephemeral classifier sessions.
    if (ephemeralSessionIDs.has(permission.sessionID)) {
      log.debug("skip: ephemeral classifier session", {
        hook: hookName,
        permissionID: permission.id,
      })
      return
    }

    // Dedupe: only handle each permission once across all hooks.
    if (handledPermissionIDs.has(permission.id)) {
      log.debug("skip: already handled", {
        hook: hookName,
        permissionID: permission.id,
      })
      return
    }
    rememberHandled(permission.id)

    log.info("hook fired", {
      hook: hookName,
      permissionID: permission.id,
      permissionType: permission.type,
      pattern: permission.pattern as unknown,
      hasOutput: output !== undefined,
    })

    try {
      await handlePermissionEvent(permission, buildCtx(), {
        hookName,
        ...(output !== undefined ? { output } : {}),
      })
    } catch (e) {
      log.error("handler threw", {
        hook: hookName,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return {
    config: async (input) => {
      // DIAGNOSTIC: dump the full config shape so we can see exactly what
      // fields opencode passes. We've already caught the Permission type
      // declaring `type`/`pattern` while the runtime emits
      // `permission`/`patterns` — Config may have the same mismatch. Remove
      // once we've calibrated the model field extraction.
      try {
        log.info("raw config shape (diagnostic)", {
          raw: JSON.stringify(input),
        })
      } catch {
        // JSON.stringify can throw on circular refs; log is best-effort.
      }

      // Pull out the plugin-specific sub-object. opencode.json permits extra
      // keys, so we access it via a safe cast.
      const pluginBlob = (input as unknown as Record<string, unknown>)[
        "delegatedAccess"
      ]
      try {
        config = parseConfig(pluginBlob)
      } catch {
        // Invalid plugin config: stick with the defaults rather than crashing
        // opencode.
        config = parseConfig(undefined)
      }

      // Extract the session's default model for the classifier's
      // auto-detection. Falls back to `small_model` if the user has one set.
      sessionModel =
        parseModelString(input.model) ?? parseModelString(input.small_model)

      // Info level (not debug) so we can tell from the log file whether
      // the config hook fires at all on this opencode version.
      log.info("config latched", {
        enabled: config.enabled,
        contextMessageCount: config.contextMessageCount,
        safeCountdownMs: config.safeCountdownMs,
        classifierTimeoutMs: config.classifierTimeoutMs,
        classifierModel: config.classifierModel,
        externalDirectoryEnabled: config.externalDirectoryEnabled,
        directoryVerdictCacheTtlMs: config.directoryVerdictCacheTtlMs,
        sessionModel: sessionModel
          ? `${sessionModel.providerID}/${sessionModel.modelID}`
          : null,
      })
    },

    // Path 1: typed permission.ask hook. If opencode dispatches this, we
    // can set output.status = "allow" to pre-empt the TUI prompt.
    "permission.ask": async (input, output) => {
      // `input` is the Permission directly (per SDK type declaration).
      await dispatch("permission.ask", input, output)
    },

    // Path 2: permission.updated hook. notification.js uses this path
    // successfully on 1.4.x. Input shape is not formally typed in the SDK;
    // probe defensively below.
    //
    // This hook is registered via a direct string key since @opencode-ai/
    // plugin's Hooks type doesn't declare it.
    ...({
      "permission.updated": async (input: unknown) => {
        const permission = extractPermission(input)
        await dispatch("permission.updated", permission)
      },
    } as Record<string, (input: unknown) => Promise<void>>),

    // Path 3: generic event hook. Filter to permission.asked /
    // permission.updated event types.
    event: async ({ event }) => {
      const type: string = event.type
      if (type !== "permission.asked" && type !== "permission.updated") return

      const permission = extractPermission(event)
      await dispatch(`event:${type}`, permission)
    },
  }
}

/**
 * Defensively extract a `Permission` from whatever shape opencode hands
 * our hooks. Different hooks (and possibly different opencode versions)
 * send different shapes; we probe the common locations:
 *
 *   - `input` itself is a Permission (typed hook path)
 *   - `input.permission` (possible nested shape)
 *   - `input.properties` (event-hook shape: `{ type, properties: Permission }`)
 *   - `input.event.properties` (nested event wrapping)
 *
 * Returns `null` if nothing resembling a Permission is found.
 */
function extractPermission(input: unknown): Permission | null {
  if (!input || typeof input !== "object") return null
  const candidates: unknown[] = [
    input,
    (input as { permission?: unknown }).permission,
    (input as { properties?: unknown }).properties,
    (input as { event?: { properties?: unknown } }).event?.properties,
  ]
  for (const c of candidates) {
    if (
      c &&
      typeof c === "object" &&
      typeof (c as { id?: unknown }).id === "string" &&
      typeof (c as { sessionID?: unknown }).sessionID === "string"
    ) {
      return c as Permission
    }
  }
  return null
}

/**
 * Parse opencode's `model: "provider/model-id"` shape into a ModelRef, or
 * undefined if the input is missing/malformed. Model IDs may contain
 * slashes (e.g. openrouter's "anthropic/claude-haiku"), so we split on the
 * first slash only.
 */
function parseModelString(input: string | undefined): ModelRef | undefined {
  if (typeof input !== "string") return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  }
}

export default DelegatedAccess
