/** Opencode's canonical reference to a specific model. */
export type ModelRef = {
  providerID: string
  modelID: string
}

/**
 * Small, fast model each known provider defaults to for classification.
 *
 * These values are a reasonable baseline as of spec authoring; users can
 * always override via the `classifierModel` plugin config when vendors ship
 * newer or cheaper small models.
 */
export const PROVIDER_DEFAULT_SMALL_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
  google: "gemini-2.5-flash-lite",
}

/**
 * Pure resolver: pick the classifier model.
 *
 * Precedence:
 *   1. Explicit `configOverride` (format: `providerID/modelID`, modelID may
 *      itself contain slashes)
 *   2. Known-provider default based on the session's current model
 *   3. Fall back to the session's model itself (same-model classifier — still
 *      correct, just slower/more expensive)
 *   4. `null` when there's no override and no session model (caller must
 *      fail closed)
 */
export function resolveClassifierModel(args: {
  configOverride: string | undefined
  sessionModel: ModelRef | undefined
}): ModelRef | null {
  const { sessionModel } = args
  const override = args.configOverride?.trim()

  if (override && override.length > 0) {
    const slash = override.indexOf("/")
    if (slash <= 0 || slash === override.length - 1) {
      // Malformed override: no slash, leading slash, or trailing slash.
      return null
    }
    return {
      providerID: override.slice(0, slash),
      modelID: override.slice(slash + 1),
    }
  }

  if (!sessionModel) return null

  const smallModel = PROVIDER_DEFAULT_SMALL_MODELS[sessionModel.providerID]
  if (smallModel) {
    return { providerID: sessionModel.providerID, modelID: smallModel }
  }

  return sessionModel
}
