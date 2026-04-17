import type { Plugin } from "@opencode-ai/plugin"
import { parseConfig, type DelegatedAccessConfig } from "./config.ts"
import {
  handlePermissionEvent,
  type HandlerContext,
} from "./permission/handler.ts"
import type { ModelRef } from "./classifier/model.ts"

/**
 * OpenCode plugin entry point.
 *
 * Listens on the generic `event` hook for `permission.asked` events.
 * opencode 1.4.x does NOT dispatch the `permission.ask` hook declared in the
 * plugin SDK types (it's declared but unwired in the compiled runtime), so
 * the event-driven path is the only reliable attach point. Consequence: the
 * TUI prompt briefly appears for SAFE commands before we auto-dismiss it via
 * the permission-respond SDK endpoint.
 *
 * Plugin config: opencode.json → top-level `delegatedAccess` object. Any
 * shape mismatch is ignored; defaults fill in.
 *
 * Example:
 *   {
 *     "delegatedAccess": {
 *       "enabled": true,
 *       "contextMessageCount": 3,
 *       "classifierModel": "anthropic/claude-haiku-4-5"
 *     }
 *   }
 */
const DelegatedAccess: Plugin = async ({ client }) => {
  // Config is resolved lazily — we receive the full config blob via the
  // `config` hook and latch the plugin-specific subsection. Defaults take
  // over until the first `config` call or if the user never sets any.
  let config: DelegatedAccessConfig = parseConfig(undefined)

  // The session's default model, resolved from opencode's Config. Updated
  // on every `config` call so it stays in sync when the user changes models.
  let sessionModel: ModelRef | undefined

  // Track IDs of ephemeral classifier sessions we create. The `event` hook
  // skips `permission.asked` events whose `sessionID` is in this set, so the
  // classifier can't trigger itself (defense-in-depth — the classifier runs
  // with `tools: {}` so in practice it can't request permissions).
  const ephemeralSessionIDs = new Set<string>()

  // Permissions we've already handled, to avoid re-processing if opencode
  // emits multiple events per permission (e.g. both `permission.asked` and
  // `permission.updated` for the same permissionID).
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

  return {
    config: async (input) => {
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
    },

    event: async ({ event }) => {
      // We handle both "permission.asked" (emitted by opencode 1.4.x but
      // not declared in the SDK's Event union — we compare it as a plain
      // string) and "permission.updated" (typed in the SDK; fired when a
      // permission's state changes). The permissionID dedupe set ensures
      // we only classify each permission once.
      const type: string = event.type
      if (type !== "permission.asked" && type !== "permission.updated") return

      // Both event variants carry a Permission in `properties`.
      const permission = (event as unknown as {
        properties: import("@opencode-ai/sdk").Permission
      }).properties
      if (!permission || typeof permission.id !== "string") return

      // Loop-guard: skip events from our own ephemeral classifier sessions.
      if (ephemeralSessionIDs.has(permission.sessionID)) return

      // Dedupe: only handle each permission once.
      if (handledPermissionIDs.has(permission.id)) return
      rememberHandled(permission.id)

      const ctx: HandlerContext = {
        client,
        config,
        sessionModel,
        ephemeralSessionIDs,
      }

      try {
        await handlePermissionEvent(permission, ctx)
      } catch {
        // Defensive catch-all: any unexpected error in our code must not
        // crash the session. The TUI prompt remains as a fallback.
      }
    },
  }
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
