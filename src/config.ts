import { z } from "zod"

/**
 * User-facing configuration for the delegated-access plugin.
 *
 * All fields are optional at the input layer; defaults are filled in by
 * {@link ConfigSchema}. See the design spec for rationale:
 * `docs/superpowers/specs/2026-04-17-delegated-access-design.md`.
 */
export const ConfigSchema = z.object({
  /** Master toggle. When false, the plugin passes through to normal opencode approval. */
  enabled: z.boolean().default(true),

  /** Last K user messages to include as context for the safety classifier. */
  contextMessageCount: z.number().int().min(0).max(20).default(3),

  /**
   * For SAFE commands, how long to show the cancellable notification before
   * auto-approving. 0 disables the countdown (silent auto-approve).
   */
  safeCountdownMs: z.number().int().min(0).max(60_000).default(5_000),

  /**
   * Override for the classifier model, in `providerID/modelID` form.
   * If unset, the plugin auto-detects based on the session's current provider.
   */
  classifierModel: z.string().optional(),

  /**
   * Fail-closed timeout for a single classifier call. Haiku-class models
   * streaming a structured verdict typically respond in 3–10 seconds; 15s
   * gives comfortable headroom without making the user wait forever on a
   * stuck classifier.
   */
  classifierTimeoutMs: z.number().int().min(500).max(60_000).default(15_000),

  /** Whether OS notifications play a sound. */
  notificationSound: z.boolean().default(true),
})

export type DelegatedAccessConfig = z.infer<typeof ConfigSchema>

/**
 * Canonical defaults. Exported for tests and for documentation consumers.
 * `classifierModel` is intentionally omitted (it's optional with no default).
 */
export const DEFAULT_CONFIG: DelegatedAccessConfig = ConfigSchema.parse({})

/**
 * Parse an unknown value (e.g. a plugin config blob from opencode) into a
 * validated {@link DelegatedAccessConfig}. Throws {@link z.ZodError} on
 * invalid input. Pass `undefined` to get the defaults.
 */
export function parseConfig(input: unknown): DelegatedAccessConfig {
  return ConfigSchema.parse(input ?? {})
}
