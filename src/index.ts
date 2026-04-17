import type { Plugin } from "@opencode-ai/plugin"
import { parseConfig, type DelegatedAccessConfig } from "./config.ts"
import { handlePermission } from "./permission/handler.ts"
import type { ModelRef } from "./classifier/model.ts"

/**
 * OpenCode plugin entry point.
 *
 * Registers the `permission.ask` hook with an async classifier that can
 * auto-approve safe bash commands and escalate risky ones via an OS
 * notification. See `docs/superpowers/specs/` for the full design.
 *
 * Plugin config: opencode.json → top-level `delegatedAccess` object
 *   (the key is outside the official Config schema; opencode.json allows
 *   arbitrary top-level keys, so the raw blob still reaches the `config`
 *   hook). Any shape mismatch is ignored; defaults fill in.
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
      sessionModel = parseModelString(input.model) ?? parseModelString(
        input.small_model,
      )
    },

    "permission.ask": async (permInput, output) => {
      try {
        await handlePermission(permInput, output, {
          client,
          config,
          sessionModel,
        })
      } catch {
        // Defensive catch-all: any unexpected error in our code must not
        // crash the session or leave output in an unknown state. Fall back
        // to the normal user approval prompt.
        output.status = "ask"
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
