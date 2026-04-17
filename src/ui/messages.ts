import type { Message, Part } from "@opencode-ai/sdk"
import type { createOpencodeClient } from "@opencode-ai/sdk"

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
 * Thin I/O wrapper: fetch the session's messages via the SDK and return the
 * last K user messages as text. Encapsulates the one HTTP call so the pure
 * logic in {@link extractLastUserMessages} can be unit-tested in isolation.
 */
export async function getLastUserMessages(
  client: OpencodeClient,
  sessionID: string,
  k: number,
): Promise<string[]> {
  const response = await client.session.messages({ path: { id: sessionID } })
  const entries = (response.data ?? []) as MessageEntry[]
  return extractLastUserMessages(entries, k)
}
