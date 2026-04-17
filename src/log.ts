import type { createOpencodeClient } from "@opencode-ai/sdk"

type OpencodeClient = ReturnType<typeof createOpencodeClient>

/** Log levels opencode's server logger accepts. */
type Level = "debug" | "info" | "warn" | "error"

/**
 * A small, fire-and-forget logger that writes to opencode's server log via
 * `client.app.log`. Entries with `service=delegated-access` end up in the
 * same `~/.local/share/opencode/log/*.log` file as opencode's own logs, so
 * you can grep them with:
 *
 *     grep "service=delegated-access" ~/.local/share/opencode/log/*.log
 *
 * This bypasses the TUI prompt-bar sink (which hides plugin console output
 * behind permission UIs and other overlays), giving us a reliable side-
 * channel for diagnostics that's visible regardless of what's on-screen.
 *
 * Semantics:
 *   - Every call is fire-and-forget (returns void synchronously).
 *   - Failures fall back to `console.error` with the [delegated-access]
 *     prefix so nothing is silently lost if the log endpoint is unreachable.
 *   - Never throws.
 */
export type Logger = {
  debug: (message: string, extra?: Record<string, unknown>) => void
  info: (message: string, extra?: Record<string, unknown>) => void
  warn: (message: string, extra?: Record<string, unknown>) => void
  error: (message: string, extra?: Record<string, unknown>) => void
}

/** Service name embedded in every log entry from this plugin. */
export const LOG_SERVICE = "delegated-access"

const CONSOLE_PREFIX = "[delegated-access]"

function formatFallback(
  level: Level,
  message: string,
  extra: Record<string, unknown> | undefined,
): string {
  const extraPart = extra ? ` ${JSON.stringify(extra)}` : ""
  return `${CONSOLE_PREFIX} ${level} ${message}${extraPart}`
}

/**
 * Build a logger bound to the given opencode client. All entries are tagged
 * with `service=${LOG_SERVICE}`.
 */
export function createLogger(client: OpencodeClient): Logger {
  function emit(
    level: Level,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    // Fire-and-forget — never await, never surface errors to the caller.
    Promise.resolve()
      .then(() =>
        client.app.log({
          body: {
            service: LOG_SERVICE,
            level,
            message,
            ...(extra !== undefined ? { extra } : {}),
          },
        }),
      )
      .catch((err: unknown) => {
        // Fallback: write to stderr so the log isn't entirely lost when the
        // server log endpoint is unreachable. This is the same sink plugin
        // console output went to before; degraded but not silent.
        const errPart = err instanceof Error ? ` (${err.message})` : ""
        console.error(formatFallback(level, message, extra) + errPart)
      })
  }

  return {
    debug: (message, extra) => emit("debug", message, extra),
    info: (message, extra) => emit("info", message, extra),
    warn: (message, extra) => emit("warn", message, extra),
    error: (message, extra) => emit("error", message, extra),
  }
}
