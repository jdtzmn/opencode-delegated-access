import type { createOpencodeClient, Session } from "@opencode-ai/sdk"

type OpencodeClient = ReturnType<typeof createOpencodeClient>

/**
 * Maximum number of `parentID` hops we'll follow before giving up. Real-world
 * subagent chains are typically 1-2 levels deep; this bound is generous
 * enough that we should never hit it in practice, and short enough that a
 * pathological mis-configuration can't chew through API calls.
 */
export const MAX_SESSION_PARENT_DEPTH = 10

/**
 * Walk a session's `parentID` chain up to the root session.
 *
 * Subagent dispatches in opencode create child sessions whose `parentID`
 * points at the dispatcher's session. To preserve the plugin's safety
 * property ("classifier only sees human messages"), bash permissions
 * originating inside a subagent must be classified against the ROOT
 * session's user messages — not the subagent's, whose "user" role entries
 * are the dispatching agent's prompts.
 *
 * Fail-closed contract: returns `null` on ANY failure (session.get error,
 * missing payload, max depth exceeded, cycle detected). Callers MUST treat
 * `null` as "abort classification and leave the TUI prompt alone" so we
 * never auto-approve a command whose true chain-of-custody we couldn't
 * verify.
 *
 * @param client - opencode SDK client
 * @param sessionID - the session ID where the permission originated
 * @returns the root session's ID, or `null` if the root could not be
 *   reliably determined
 */
export async function resolveRootSessionID(
  client: OpencodeClient,
  sessionID: string,
): Promise<string | null> {
  const seen = new Set<string>()
  let current = sessionID

  for (let hops = 0; hops <= MAX_SESSION_PARENT_DEPTH; hops++) {
    // Cycle guard: if we've seen this ID before, the tree is malformed.
    if (seen.has(current)) return null
    seen.add(current)

    let session: Session
    try {
      const response = (await client.session.get({
        path: { id: current },
      } as never)) as { data?: Session } | undefined
      if (!response?.data) return null
      session = response.data
    } catch {
      return null
    }

    // No parent → we've reached the root.
    if (typeof session.parentID !== "string" || session.parentID.length === 0) {
      return current
    }

    current = session.parentID
  }

  // Exceeded MAX_SESSION_PARENT_DEPTH without finding a root.
  return null
}
