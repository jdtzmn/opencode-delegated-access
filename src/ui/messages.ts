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
 */
export function extractLastUserMessages(
  entries: MessageEntry[],
  k: number,
): string[] {
  if (k <= 0) return []

  const userTexts: string[] = []
  for (const entry of entries) {
    if (entry.info.role !== "user") continue
    const text = messageText(entry)
    if (text.length === 0) continue
    userTexts.push(text)
  }

  return userTexts.slice(-k)
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
