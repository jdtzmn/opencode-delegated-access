import { describe, it, expect, vi } from "vitest"
import { resolveRootSessionID } from "./session-tree.ts"

/**
 * Build a mock opencode client whose `session.get` resolves sessionIDs to
 * their `{ parentID }` shape from a provided map. IDs missing from the map
 * throw a "Not found" error so we can exercise the fail-closed path.
 *
 * Returns both the client and a spy on `session.get` so tests can assert on
 * the call sequence.
 */
function buildClient(parents: Record<string, string | undefined>) {
  const get = vi.fn(async ({ path }: { path: { id: string } }) => {
    if (!(path.id in parents)) {
      throw new Error(`Session ${path.id} not found`)
    }
    const parentID = parents[path.id]
    return {
      data: {
        id: path.id,
        projectID: "proj",
        directory: "/",
        title: "t",
        version: "v",
        time: { created: 0, updated: 0 },
        ...(parentID !== undefined ? { parentID } : {}),
      },
    }
  })
  return {
    client: { session: { get } },
    get,
  }
}

describe("resolveRootSessionID", () => {
  it("returns the input sessionID when the session has no parent (root)", async () => {
    const { client, get } = buildClient({ root: undefined })
    const result = await resolveRootSessionID(client as never, "root")
    expect(result).toBe("root")
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("walks up one level to find the root", async () => {
    const { client } = buildClient({
      child: "root",
      root: undefined,
    })
    const result = await resolveRootSessionID(client as never, "child")
    expect(result).toBe("root")
  })

  it("walks up multiple levels to find the root", async () => {
    const { client } = buildClient({
      leaf: "mid2",
      mid2: "mid1",
      mid1: "root",
      root: undefined,
    })
    const result = await resolveRootSessionID(client as never, "leaf")
    expect(result).toBe("root")
  })

  it("returns null when session.get throws at the starting session", async () => {
    const { client } = buildClient({})
    const result = await resolveRootSessionID(client as never, "missing")
    expect(result).toBeNull()
  })

  it("returns null when session.get throws mid-chain", async () => {
    const { client } = buildClient({
      leaf: "mid",
      // mid intentionally absent from the map → throws
    })
    const result = await resolveRootSessionID(client as never, "leaf")
    expect(result).toBeNull()
  })

  it("returns null when the chain exceeds the max depth of 10", async () => {
    // 12 levels of nesting: n11 → n10 → ... → n0 (root)
    const chain: Record<string, string | undefined> = {}
    for (let i = 11; i > 0; i--) chain[`n${i}`] = `n${i - 1}`
    chain.n0 = undefined
    const { client } = buildClient(chain)
    const result = await resolveRootSessionID(client as never, "n11")
    expect(result).toBeNull()
  })

  it("returns the root at exactly the max-depth boundary (10 hops)", async () => {
    // 10 hops: leaf → n9 → n8 → ... → n0 (root). 11 session.get calls total.
    const chain: Record<string, string | undefined> = {}
    for (let i = 9; i > 0; i--) chain[`n${i}`] = `n${i - 1}`
    chain.n0 = undefined
    chain.leaf = "n9"
    const { client, get } = buildClient(chain)
    const result = await resolveRootSessionID(client as never, "leaf")
    expect(result).toBe("n0")
    // 11 levels fetched: leaf, n9..n0.
    expect(get).toHaveBeenCalledTimes(11)
  })

  it("returns null on a cycle (session appears twice in the chain)", async () => {
    // A → B → A → ... (cycle)
    const { client } = buildClient({
      a: "b",
      b: "a",
    })
    const result = await resolveRootSessionID(client as never, "a")
    expect(result).toBeNull()
  })

  it("returns null on a self-cycle (parentID equals own ID)", async () => {
    const { client } = buildClient({ self: "self" })
    const result = await resolveRootSessionID(client as never, "self")
    expect(result).toBeNull()
  })

  it("treats a missing/empty data payload as failure", async () => {
    const client = {
      session: {
        get: vi.fn(async () => ({ data: undefined })),
      },
    }
    const result = await resolveRootSessionID(client as never, "x")
    expect(result).toBeNull()
  })
})
