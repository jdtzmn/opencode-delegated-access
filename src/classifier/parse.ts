/**
 * The shape the classifier's LLM response is parsed into.
 *
 * Any return of {@link parseVerdict} other than this (i.e. `null`) is treated
 * by the caller as a classifier failure, which causes the plugin to fail
 * closed and fall back to the normal user approval prompt.
 */
export type Verdict = {
  verdict: "SAFE" | "RISKY"
  reason: string
}

/** Upper bound on reason length to keep log lines and notifications tidy. */
const MAX_REASON_LENGTH = 500

const VERDICT_LINE = /^\s*VERDICT\s*:\s*(SAFE|RISKY)\s*$/im
const REASON_LINE = /^\s*REASON\s*:\s*(.+?)\s*$/im

/**
 * Parse the classifier's response text into a {@link Verdict}, or return
 * `null` if the response is missing or malformed.
 *
 * Accepts both:
 *  - The canonical two-line format (`VERDICT: X\nREASON: ...`)
 *  - Responses that include a short chatty preamble before the VERDICT line
 *
 * The parser is deliberately strict about the verdict value (only SAFE or
 * RISKY are accepted) so that novel or hallucinated verdicts cause the plugin
 * to fail closed rather than silently passing through.
 */
export function parseVerdict(text: string): Verdict | null {
  if (!text) return null

  const verdictMatch = text.match(VERDICT_LINE)
  if (!verdictMatch || !verdictMatch[1]) return null
  const verdict = verdictMatch[1].toUpperCase() as "SAFE" | "RISKY"

  const reasonMatch = text.match(REASON_LINE)
  const rawReason = reasonMatch?.[1] ?? ""
  const reason =
    rawReason.length > MAX_REASON_LENGTH
      ? rawReason.slice(0, MAX_REASON_LENGTH)
      : rawReason

  return { verdict, reason }
}
