/**
 * Registry + transform for isolating the ephemeral classifier session's
 * system prompt from opencode's global instruction context.
 *
 * ## Why this exists
 *
 * `session.prompt`'s `system` field is ADDED to opencode's assembled system
 * context, not a replacement (confirmed against opencode 1.15.x). That means
 * the ephemeral classifier session receives, in addition to our classifier
 * system prompt:
 *
 *   - the default agent's prompt,
 *   - the model-specific provider prompt, and
 *   - the user's GLOBAL INSTRUCTIONS (AGENTS.md, instruction files, and any
 *     skill/preamble injected there — e.g. a "you MUST invoke the
 *     using-superpowers skill before ANY response" directive).
 *
 * Those global instructions out-muscle our classifier prompt: the small
 * classifier model starts behaving like a full agent ("Let me invoke the
 * using-superpowers skill…") and never emits a `VERDICT:` line, so
 * `parseVerdict` fails and the classification falls closed. Observed in
 * production as repeated `classifier: response did not parse` warnings.
 *
 * The `experimental.chat.system.transform` plugin hook receives the fully
 * assembled `system: string[]` for a prompt and lets us mutate it. For our
 * ephemeral classifier sessions ONLY, we replace the entire array with just
 * the classifier system prompt — stripping the polluting global context so
 * the classifier sees nothing but its own instructions.
 */

/**
 * Maps an ephemeral classifier session ID to the exact system prompt that
 * session's classification should use. Populated by the classify path right
 * after it creates the ephemeral session, read by the system-transform hook,
 * and cleared when the session is deleted.
 */
export class EphemeralSystemRegistry {
  private readonly _map = new Map<string, string>()

  set(sessionID: string, systemPrompt: string): void {
    this._map.set(sessionID, systemPrompt)
  }

  get(sessionID: string): string | undefined {
    return this._map.get(sessionID)
  }

  has(sessionID: string): boolean {
    return this._map.has(sessionID)
  }

  delete(sessionID: string): void {
    this._map.delete(sessionID)
  }
}

/**
 * Body of the `experimental.chat.system.transform` hook. If `input.sessionID`
 * is one of our registered ephemeral classifier sessions, replace the
 * assembled system array IN PLACE with only the registered classifier prompt.
 * Otherwise leave it untouched.
 *
 * Mutates `output.system` in place (same array reference) because opencode
 * may have captured the reference before invoking the hook.
 */
export function applyEphemeralSystemTransform(
  input: { sessionID?: string },
  output: { system: string[] },
  registry: EphemeralSystemRegistry,
): void {
  const sessionID = input.sessionID
  if (!sessionID) return
  const classifierPrompt = registry.get(sessionID)
  if (classifierPrompt === undefined) return

  // Replace contents in place: clear, then push the single classifier prompt.
  output.system.length = 0
  output.system.push(classifierPrompt)
}
