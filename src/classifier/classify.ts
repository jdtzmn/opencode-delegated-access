import type { createOpencodeClient, Part } from "@opencode-ai/sdk"
import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserPrompt,
} from "./prompt.ts"
import { parseVerdict, type Verdict } from "./parse.ts"
import type { ModelRef } from "./model.ts"

type OpencodeClient = ReturnType<typeof createOpencodeClient>

/**
 * Title for the ephemeral classifier session. Picked to be obvious if a user
 * ever sees one in a session list so they know it's plugin-generated.
 */
const CLASSIFIER_SESSION_TITLE = "[delegated-access classifier]"

/**
 * Run the safety classifier for a permission subject (a bash command, a
 * directory path, or any future permission type) and return a verdict.
 *
 * Callers supply the LLM system prompt and a user-prompt builder so this
 * function remains agnostic about what is being classified.
 *
 * Flow:
 *   1. Create an ephemeral child session (hidden from top-level lists via
 *      `parentID: <caller's sessionID>`).
 *   2. Call `session.prompt` with the classifier model, the caller-supplied
 *      system prompt, `tools: { "*": false }` (deny all tools), and the user
 *      prompt built from the subject + recent user messages.
 *   3. Parse the response's text parts with {@link parseVerdict}.
 *   4. Always delete the ephemeral session in a `finally` block (errors
 *      swallowed — cleanup is best-effort).
 *
 * Fail-closed behaviour: returns `null` for any error, malformed response,
 * or timeout exceeding `timeoutMs`. Callers should treat `null` as "classifier
 * failure → fall back to the normal opencode approval prompt".
 */
export async function classifySubject(args: {
  client: OpencodeClient
  /** The string being classified (command, path pattern, etc.). */
  subject: string
  /** Recent human-authored messages to give the classifier context. */
  userMessages: string[]
  parentSessionID: string
  model: ModelRef
  timeoutMs: number
  /** LLM system prompt for this permission type. */
  systemPrompt: string
  /**
   * Builds the user-turn prompt from `subject` + `userMessages`.
   * Called exactly once per invocation with the same `subject`/`userMessages`
   * passed to this function.
   */
  buildUserPrompt: (args: {
    subject: string
    userMessages: string[]
  }) => string
  /**
   * Called with the ephemeral classifier session's ID as soon as it's
   * created. Callers can track these IDs to filter out downstream
   * `permission.asked` events the classifier session itself might generate
   * (defense-in-depth — the classifier uses `tools: { "*": false }` so in
   * practice it can't request any permissions).
   */
  onEphemeralSessionCreated?: (id: string) => void
  /**
   * Called with the ephemeral session's ID after deletion completes (or
   * fails — cleanup is best-effort). Callers should clear the session ID
   * from their tracking set here.
   */
  onEphemeralSessionDeleted?: (id: string) => void
}): Promise<Verdict | null> {
  const {
    client,
    subject,
    userMessages,
    parentSessionID,
    model,
    timeoutMs,
    systemPrompt,
    buildUserPrompt,
    onEphemeralSessionCreated,
    onEphemeralSessionDeleted,
  } = args

  // Step 1: create ephemeral child session.
  let ephemeralID: string | undefined
  try {
    const created = await client.session.create({
      body: {
        parentID: parentSessionID,
        title: CLASSIFIER_SESSION_TITLE,
      },
    } as never)
    ephemeralID = (created as { data?: { id?: string } }).data?.id
  } catch {
    return null
  }
  if (!ephemeralID) return null
  onEphemeralSessionCreated?.(ephemeralID)

  let timedOut = false
  try {
    // Step 2: classifier prompt with timeout.
    const userPrompt = buildUserPrompt({ subject, userMessages })

    const promptCall = client.session.prompt({
      path: { id: ephemeralID },
      body: {
        model,
        system: systemPrompt,
        // Deny ALL tools for this prompt. In opencode 1.4.x, `tools: {}` is
        // interpreted as "no overrides" and the ephemeral session still
        // receives the full tool registry — which the classifier has been
        // observed to actually invoke (e.g. calling `bash` to run the very
        // command it was supposed to merely classify). The wildcard `"*":
        // false` form explicitly denies every tool via the server's
        // permission ruleset.
        tools: { "*": false },
        parts: [{ type: "text", text: userPrompt }],
      },
    } as never)

    const response = (await withTimeout(promptCall, timeoutMs, async () => {
      // Flip the gate BEFORE awaiting abort so that if the prompt promise
      // settles during the abort call (a race observed on opencode 1.4.x
      // where the server flushes pre-abort stream chunks on cancel), the
      // post-race fail-closed check below can still discard it.
      timedOut = true
      // Await the abort so opencode's session.processor has a chance to
      // stop streaming BEFORE the finally-block deletes the session. If we
      // skip this wait, the still-streaming LLM response can race the
      // delete and surface a "Session not found" error toast in the TUI.
      try {
        await client.session.abort({ path: { id: ephemeralID! } } as never)
      } catch {
        // Abort is best-effort; the post-abort settle delay still protects
        // us from the common races.
      }
    })) as { data?: { parts?: Part[] } } | null

    // Fail-closed gate: if the timeout fired at ANY point during the race,
    // discard whatever the prompt promise returned. Partial pre-abort
    // streams have been observed to contain well-formed "VERDICT: SAFE"
    // text that would otherwise auto-approve a command whose classification
    // never actually completed — violating the plugin's fail-closed
    // contract (see README "How it's safe").
    if (timedOut) return null

    if (!response) return null

    // Step 3: parse.
    const text = responseTextFromParts(response.data?.parts ?? [])
    return parseVerdict(text)
  } catch {
    return null
  } finally {
    // Step 4: best-effort cleanup. On the timeout path, give the server a
    // brief moment to fully quiesce the aborted stream before we delete —
    // without this grace window, late LLM chunks arriving at the deleted
    // session surface as a "Session not found" error toast in the TUI.
    if (timedOut) {
      await sleep(POST_ABORT_SETTLE_MS)
    }
    try {
      await client.session.delete({ path: { id: ephemeralID } } as never)
    } catch {
      // Swallow — cleanup must not affect the returned verdict.
    }
    onEphemeralSessionDeleted?.(ephemeralID)
  }
}

/**
 * Convenience wrapper around {@link classifySubject} that supplies the
 * bash-specific system prompt and user-prompt builder. Preserved so
 * existing call-sites in handler.ts need no changes.
 */
export function classifyCommand(
  args: Omit<
    Parameters<typeof classifySubject>[0],
    "subject" | "systemPrompt" | "buildUserPrompt"
  > & { command: string },
): ReturnType<typeof classifySubject> {
  const { command, ...rest } = args
  return classifySubject({
    ...rest,
    subject: command,
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    buildUserPrompt: ({ subject, userMessages }) =>
      buildClassifierUserPrompt({ command: subject, userMessages }),
  })
}

/** Grace period between aborting a timed-out prompt and deleting the session. */
const POST_ABORT_SETTLE_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Concatenate all text parts of a session.prompt response into a single
 * string for the parser to inspect. Non-text parts are ignored.
 */
function responseTextFromParts(parts: Part[]): string {
  return parts
    .filter((p): p is Part & { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
}

/**
 * Race a promise against a timeout. If the timeout fires first, awaits
 * `onTimeout` (so callers can cleanly abort in-flight work before the
 * caller's finally-block runs) and then resolves to `null`. Otherwise
 * passes through the promise's result.
 */
async function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void> | void,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(async () => {
      try {
        await onTimeout()
      } catch {
        // Timeout handler errors are swallowed — we're on the failure path.
      }
      resolve(null)
    }, timeoutMs)
  })
  try {
    const result = await Promise.race([p, timeout])
    return result as T | null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
