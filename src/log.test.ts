import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createLogger, LOG_SERVICE } from "./log.ts"

function buildClient(impl?: (opts: unknown) => Promise<unknown>) {
  const logCall = vi.fn(impl ?? (async () => ({ data: {} } as unknown)))
  return {
    client: { app: { log: logCall } } as never,
    logCall,
  }
}

/** Wait one macrotask so fire-and-forget promises settle. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("createLogger", () => {
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    errSpy.mockRestore()
  })

  it("emits info/debug/warn/error through client.app.log with the service tag", async () => {
    const { client, logCall } = buildClient()
    const log = createLogger(client)

    log.debug("d-msg")
    log.info("i-msg")
    log.warn("w-msg")
    log.error("e-msg")
    await flush()

    expect(logCall).toHaveBeenCalledTimes(4)
    const bodies = logCall.mock.calls.map(
      (c) => (c[0] as { body: { service: string; level: string; message: string } }).body,
    )
    expect(bodies).toEqual([
      { service: LOG_SERVICE, level: "debug", message: "d-msg" },
      { service: LOG_SERVICE, level: "info", message: "i-msg" },
      { service: LOG_SERVICE, level: "warn", message: "w-msg" },
      { service: LOG_SERVICE, level: "error", message: "e-msg" },
    ])
  })

  it("passes extra metadata through to client.app.log", async () => {
    const { client, logCall } = buildClient()
    const log = createLogger(client)

    log.info("hello", { permissionID: "perm_1", verdict: "SAFE" })
    await flush()

    expect(logCall).toHaveBeenCalledTimes(1)
    const body = (logCall.mock.calls[0]?.[0] as {
      body: { extra?: Record<string, unknown> }
    }).body
    expect(body.extra).toEqual({ permissionID: "perm_1", verdict: "SAFE" })
  })

  it("omits the extra key when no metadata is passed", async () => {
    const { client, logCall } = buildClient()
    const log = createLogger(client)

    log.info("hello")
    await flush()

    const body = (logCall.mock.calls[0]?.[0] as {
      body: { extra?: unknown }
    }).body
    expect(body.extra).toBeUndefined()
  })

  it("is fire-and-forget: returns void synchronously", () => {
    const { client } = buildClient()
    const log = createLogger(client)
    const result = log.info("hi")
    expect(result).toBeUndefined()
  })

  it("never throws even if the client.app.log call rejects", async () => {
    const { client } = buildClient(async () => {
      throw new Error("boom")
    })
    const log = createLogger(client)

    expect(() => log.info("hi")).not.toThrow()
    await flush()

    // Fallback to console.error.
    expect(errSpy).toHaveBeenCalledTimes(1)
    const fallbackMsg = errSpy.mock.calls[0]?.[0] as string
    expect(fallbackMsg).toContain("[delegated-access]")
    expect(fallbackMsg).toContain("info")
    expect(fallbackMsg).toContain("hi")
    expect(fallbackMsg).toContain("boom")
  })

  it("never throws even if the client.app.log call throws synchronously", async () => {
    const client = {
      app: {
        log: () => {
          throw new Error("sync boom")
        },
      },
    } as never
    const log = createLogger(client)

    expect(() => log.error("oops", { ctx: "x" })).not.toThrow()
    await flush()

    expect(errSpy).toHaveBeenCalledTimes(1)
    const fallbackMsg = errSpy.mock.calls[0]?.[0] as string
    expect(fallbackMsg).toContain("error")
    expect(fallbackMsg).toContain("oops")
    expect(fallbackMsg).toContain('"ctx":"x"')
    expect(fallbackMsg).toContain("sync boom")
  })

  it("fallback formats extra as JSON", async () => {
    const { client } = buildClient(async () => {
      throw new Error("fail")
    })
    const log = createLogger(client)

    log.warn("msg", { count: 3, nested: { ok: true } })
    await flush()

    const out = errSpy.mock.calls[0]?.[0] as string
    expect(out).toContain('"count":3')
    expect(out).toContain('"nested":{"ok":true}')
  })
})
