import { describe, it, expect } from "vitest"
import { startCallbackServer, type CallbackOutcome } from "./callback-server.ts"

async function hit(url: string) {
  return fetch(url).then((r) => r.status).catch(() => -1)
}

describe("startCallbackServer", () => {
  it("returns a server with distinct URLs per outcome", async () => {
    const server = await startCallbackServer({ outcomes: ["approve", "reject"] })
    expect(server.urls.approve).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[^/]+\/approve$/)
    expect(server.urls.reject).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[^/]+\/reject$/)
    expect(server.urls.approve).not.toEqual(server.urls.reject)
    await server.close()
  })

  it("resolves with 'approve' when the approve URL is hit", async () => {
    const server = await startCallbackServer({ outcomes: ["approve", "reject"] })
    const [outcome] = await Promise.all([server.outcome, hit(server.urls.approve)])
    expect(outcome).toBe<CallbackOutcome>("approve")
  })

  it("resolves with 'reject' when the reject URL is hit", async () => {
    const server = await startCallbackServer({ outcomes: ["approve", "reject"] })
    const [outcome] = await Promise.all([server.outcome, hit(server.urls.reject)])
    expect(outcome).toBe<CallbackOutcome>("reject")
  })

  it("resolves with 'cancel' when the cancel URL is hit (single-outcome form)", async () => {
    const server = await startCallbackServer({ outcomes: ["cancel"] })
    const [outcome] = await Promise.all([server.outcome, hit(server.urls.cancel)])
    expect(outcome).toBe<CallbackOutcome>("cancel")
  })

  it("first hit wins; subsequent hits are ignored after close()", async () => {
    const server = await startCallbackServer({ outcomes: ["approve", "reject"] })
    const [outcome] = await Promise.all([server.outcome, hit(server.urls.approve)])
    expect(outcome).toBe("approve")
    // After the outcome resolves the server should close itself.
    // A subsequent request either 404s or fails-to-connect; either is fine.
    const status = await hit(server.urls.reject)
    expect([404, -1]).toContain(status)
  })

  it("rejects requests with a wrong token (404)", async () => {
    const server = await startCallbackServer({ outcomes: ["approve", "reject"] })
    const badUrl = server.urls.approve.replace(/\/[^/]+\/approve$/, "/wrong/approve")
    const status = await hit(badUrl)
    expect(status).toBe(404)
    await server.close()
  })

  it("rejects requests with a wrong outcome path (404)", async () => {
    const server = await startCallbackServer({ outcomes: ["approve", "reject"] })
    const badUrl = server.urls.approve.replace(/\/approve$/, "/nonsense")
    const status = await hit(badUrl)
    expect(status).toBe(404)
    await server.close()
  })

  it("close() resolves the outcome promise with 'timeout' if not already resolved", async () => {
    const server = await startCallbackServer({ outcomes: ["approve", "reject"] })
    await server.close()
    await expect(server.outcome).resolves.toBe("timeout")
  })

  it("close() is idempotent", async () => {
    const server = await startCallbackServer({ outcomes: ["approve", "reject"] })
    await server.close()
    await server.close()
    await expect(server.outcome).resolves.toBe("timeout")
  })

  it("binds on 127.0.0.1 (loopback only)", async () => {
    const server = await startCallbackServer({ outcomes: ["approve", "reject"] })
    expect(server.urls.approve.startsWith("http://127.0.0.1:")).toBe(true)
    await server.close()
  })
})
