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

  /**
   * Number of extra classifier attempts to make if the prompt TIMES OUT.
   * `1` (default) retries a transient stall once with a fresh ephemeral
   * session and the full `classifierTimeoutMs`. `0` disables retry. Only
   * timeouts retry — other failures are never retried. Capped at 10.
   */
  classifierRetries: z.number().int().min(0).max(10).default(1),

  /** Whether OS notifications play a sound. */
  notificationSound: z.boolean().default(true),

  /**
   * When true (default), the plugin also classifies `external_directory`
   * permission requests using the directory-specific classifier prompt.
   * Set to false to restrict the plugin to bash commands only.
   */
  externalDirectoryEnabled: z.boolean().default(true),

  /**
   * How long a SAFE external_directory verdict is cached before the next
   * permission request for the same path pattern must be re-classified.
   * A 60-second window covers typical burst requests (agent globbing a tree)
   * without letting stale verdicts outlive a conversational context shift.
   */
  directoryVerdictCacheTtlMs: z
    .number()
    .int()
    .min(0)
    .max(300_000)
    .default(60_000),

  /**
   * Master toggle for the per-session approval-history feature. When true
   * (default), the plugin remembers each TUI / notification approval and
   * rejection the human makes during this session and feeds the recent
   * entries into the classifier prompt as prior-decision context. When
   * false, no recording or playback happens — classifier behaviour is
   * identical to versions before this feature shipped.
   */
  approvalHistoryEnabled: z.boolean().default(true),

  /**
   * Maximum number of recent human approval/rejection entries to pass
   * into the classifier prompt for any one permission decision. Also
   * acts as the per-session retention cap. Set to 0 to disable playback
   * (entries are still recorded; just not surfaced to the classifier).
   * Capped at 1000 to bound prompt size and memory.
   */
  approvalHistoryMax: z.number().int().min(0).max(1000).default(20),

  /**
   * When true (default), fire a desktop notification when the classifier
   * ultimately FAILS to produce a verdict for a permission (after any
   * retries) — so you get insight that a transient error happened instead
   * of silently falling back to the TUI prompt. The notification is
   * informational + Reject-only (never offers a one-click Approve on an
   * unclassified command). Set false to keep failures silent.
   */
  notifyOnClassifierFailure: z.boolean().default(true),

  /**
   * Rate-limit window (ms) for classifier-failure notifications. At most one
   * failure notification fires per window; a burst of failures during a
   * sustained outage collapses into a single notification rather than
   * spamming you. `0` disables the rate limit (every failure notifies).
   * Default 60s.
   */
  classifierFailureNotifyCooldownMs: z
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(60_000),
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
