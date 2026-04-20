import type { Message, Part } from "@opencode-ai/sdk"
import type { createOpencodeClient } from "@opencode-ai/sdk"
import type { ModelRef } from "../classifier/model.ts"

/**
 * One entry in the `client.session.messages` response: the envelope metadata
 * plus the flat list of parts comprising the message body.
 */
export type MessageEntry = {
  info: Message
  parts: Part[]
}

type OpencodeClient = ReturnType<typeof createOpencodeClient>

/**
 * Concatenate the text parts of a single message into a single string.
 * Non-text parts (files, tool calls, etc.) are ignored. If a message has no
 * text content the result is an empty string.
 */
function messageText(entry: MessageEntry): string {
  return entry.parts
    .filter((p): p is Part & { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

/**
 * Pure function: from a raw messages array return the last K user messages as
 * plain text, in chronological order. Assistant messages and non-text parts
 * are ignored.
 *
 * Messages with no text content after filtering (e.g. a user that uploaded an
 * image with no caption) are skipped entirely so they don't appear as empty
 * strings in the classifier prompt.
 *
 * When `rootAgent` is provided, only include user messages whose
 * `info.agent` matches exactly. Messages with a missing or non-string
 * `info.agent` are also excluded (fail-closed on unknown provenance).
 * This is defense-in-depth: even after walking to the root session we
 * want the classifier to see only messages the real human addressed to
 * their chosen primary agent — never synthetic dispatches that might
 * have landed under the user role.
 */
export function extractLastUserMessages(
  entries: MessageEntry[],
  k: number,
  rootAgent?: string,
): string[] {
  if (k <= 0) return []

  const userTexts: string[] = []
  for (const entry of entries) {
    if (entry.info.role !== "user") continue
    if (rootAgent !== undefined) {
      const agent = (entry.info as unknown as { agent?: unknown }).agent
      if (typeof agent !== "string" || agent !== rootAgent) continue
    }
    const text = messageText(entry)
    if (text.length === 0) continue
    userTexts.push(text)
  }

  return userTexts.slice(-k)
}

/**
 * Pure function: return the `info.agent` of the EARLIEST user message in
 * the given entries, or `null` if none have a usable string agent.
 *
 * Rationale: the first user message in a session is the human's opening
 * turn with the primary agent. That message's `agent` field is therefore
 * the authoritative name of the root session's primary agent. Later user
 * messages may drift (e.g. synthetic dispatches, system-injected turns)
 * and must not be trusted for this purpose.
 *
 * Used by the handler to anchor the `rootAgent` filter on
 * {@link extractLastUserMessages} when walking a subagent's permission
 * up to its root session.
 */
export function extractRootAgent(entries: MessageEntry[]): string | null {
  for (const entry of entries) {
    if (entry.info.role !== "user") continue
    const agent = (entry.info as unknown as { agent?: unknown }).agent
    if (typeof agent === "string" && agent.length > 0) return agent
    // Earliest user has no usable agent — keep looking forward for one.
  }
  return null
}

/**
 * Pure function: walk the entries in reverse and return the most recent
 * assistant message's `{ providerID, modelID }`. Returns `null` if no
 * assistant message exists or the latest assistant has missing/non-string
 * model fields.
 *
 * Used as a fallback source for the classifier model when opencode's
 * `config` hook hasn't fired (or hasn't carried a usable `model` value) —
 * any session that has had at least one assistant turn will have a model
 * recorded here.
 */
export function extractLatestAssistantModel(
  entries: MessageEntry[],
): ModelRef | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (!entry || entry.info.role !== "assistant") continue
    const info = entry.info as unknown as {
      providerID?: unknown
      modelID?: unknown
    }
    if (typeof info.providerID === "string" && typeof info.modelID === "string") {
      return { providerID: info.providerID, modelID: info.modelID }
    }
    // Assistant found but model fields unusable — keep looking further back.
  }
  return null
}

/**
 * Thin I/O wrapper: fetch the session's messages via the SDK and return the
 * raw entries so callers can run multiple pure extractors against a single
 * HTTP call.
 */
export async function getSessionMessages(
  client: OpencodeClient,
  sessionID: string,
): Promise<MessageEntry[]> {
  const response = await client.session.messages({ path: { id: sessionID } })
  return (response.data ?? []) as MessageEntry[]
}

/**
 * Backward-compat wrapper: fetch + extract user messages in one call. Kept
 * so existing consumers don't need to migrate; new callers should prefer
 * {@link getSessionMessages} + pure extractors for efficiency.
 */
export async function getLastUserMessages(
  client: OpencodeClient,
  sessionID: string,
  k: number,
): Promise<string[]> {
  const entries = await getSessionMessages(client, sessionID)
  return extractLastUserMessages(entries, k)
}
