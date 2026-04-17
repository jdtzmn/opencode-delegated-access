import http from "node:http"
import { randomBytes } from "node:crypto"

/** Outcomes the callback server can report. */
export type CallbackOutcome = "approve" | "reject" | "cancel" | "timeout"

/** Outcomes the server is configured to accept inbound (excludes "timeout"). */
export type AcceptedOutcome = Exclude<CallbackOutcome, "timeout">

export type CallbackServer = {
  /**
   * URLs for each outcome the server was configured to accept. Put these in
   * notification action buttons.
   */
  urls: Record<AcceptedOutcome, string>
  /** Resolves with the first outcome received or "timeout" if close() fires first. */
  outcome: Promise<CallbackOutcome>
  /** Close the underlying HTTP server and resolve `outcome` if still pending. */
  close: () => Promise<void>
}

/**
 * Spin up a loopback-only HTTP server that listens for a single outcome and
 * then shuts down.
 *
 * Each outcome is reachable at `/<random-token>/<outcome>`. The random token
 * is freshly generated per server instance so that nothing else on localhost
 * can guess and spoof a decision. The server rejects any request with a
 * mismatched token or outcome name with a 404.
 *
 * The server resolves `outcome` on the FIRST valid hit, closes itself, and
 * returns 200 to the hit. Any subsequent hit is ignored (connection refused
 * or 404 if the OS is slow to release the port).
 *
 * `close()` can be called externally (e.g. on timeout or when the other
 * channel has already resolved the permission) and will resolve `outcome`
 * with `"timeout"` if it hasn't resolved yet.
 */
export async function startCallbackServer(args: {
  outcomes: AcceptedOutcome[]
  host?: string
}): Promise<CallbackServer> {
  const host = args.host ?? "127.0.0.1"
  const token = randomBytes(16).toString("hex")
  const allowed = new Set<AcceptedOutcome>(args.outcomes)

  let resolveOutcome!: (value: CallbackOutcome) => void
  const outcome = new Promise<CallbackOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  let resolved = false
  let closed = false

  const server = http.createServer((req, res) => {
    const url = req.url ?? ""
    // Expected path: /<token>/<outcome>
    const match = url.match(/^\/([^/]+)\/([^/?#]+)/)
    if (!match || match[1] !== token) {
      res.writeHead(404)
      res.end()
      return
    }
    const requested = match[2] as AcceptedOutcome
    if (!allowed.has(requested)) {
      res.writeHead(404)
      res.end()
      return
    }
    if (resolved) {
      res.writeHead(404)
      res.end()
      return
    }
    resolved = true
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end(`OK: ${requested}`)
    resolveOutcome(requested)
    // Don't wait for other in-flight connections — close right away. Any
    // racing request will get connection-refused or 404, both fine.
    closeServer()
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("callback server: failed to obtain bound port")
  }
  const { port } = address

  const urls: Partial<Record<AcceptedOutcome, string>> = {}
  for (const o of args.outcomes) {
    urls[o] = `http://${host}:${port}/${token}/${o}`
  }

  function closeServer(): Promise<void> {
    if (closed) return Promise.resolve()
    closed = true
    return new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Forcefully close any lingering sockets so tests don't hang.
      server.closeAllConnections?.()
    })
  }

  return {
    urls: urls as Record<AcceptedOutcome, string>,
    outcome,
    close: async () => {
      await closeServer()
      if (!resolved) {
        resolved = true
        resolveOutcome("timeout")
      }
    },
  }
}
