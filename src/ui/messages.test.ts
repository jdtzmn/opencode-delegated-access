import { describe, it, expect } from "vitest"
import { extractLastUserMessages, getLastUserMessages } from "./messages.ts"
import type { MessageEntry } from "./messages.ts"

/**
 * Build a synthetic message entry for tests. The SDK returns a heavy shape;
 * these helpers keep tests readable.
 */
function userEntry(id: string, text: string): MessageEntry {
  return {
    info: {
      id,
      sessionID: "sess_test",
      role: "user",
      time: { created: 0 },
      agent: "chat",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    } as MessageEntry["info"],
    parts: [
      {
        id: `part_${id}`,
        sessionID: "sess_test",
        messageID: id,
        type: "text",
        text,
      } as MessageEntry["parts"][number],
    ],
  }
}

function assistantEntry(id: string, text: string): MessageEntry {
  return {
    info: {
      id,
      sessionID: "sess_test",
      role: "assistant",
      time: { created: 0 },
      parentID: "parent",
      modelID: "claude-sonnet-4-5",
      providerID: "anthropic",
      mode: "default",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    } as MessageEntry["info"],
    parts: [
      {
        id: `part_${id}`,
        sessionID: "sess_test",
        messageID: id,
        type: "text",
        text,
      } as MessageEntry["parts"][number],
    ],
  }
}

function multiPartUserEntry(id: string, texts: string[]): MessageEntry {
  return {
    info: {
      id,
      sessionID: "sess_test",
      role: "user",
      time: { created: 0 },
      agent: "chat",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    } as MessageEntry["info"],
    parts: texts.map(
      (text, i) =>
        ({
          id: `part_${id}_${i}`,
          sessionID: "sess_test",
          messageID: id,
          type: "text",
          text,
        }) as MessageEntry["parts"][number],
    ),
  }
}

describe("extractLastUserMessages", () => {
  it("returns an empty array when K is 0", () => {
    const entries = [userEntry("1", "hello"), userEntry("2", "world")]
    expect(extractLastUserMessages(entries, 0)).toEqual([])
  })

  it("returns the last K user messages in chronological order", () => {
    const entries = [
      userEntry("1", "first"),
      userEntry("2", "second"),
      userEntry("3", "third"),
      userEntry("4", "fourth"),
    ]
    expect(extractLastUserMessages(entries, 2)).toEqual(["third", "fourth"])
  })

  it("ignores assistant messages", () => {
    const entries = [
      userEntry("1", "user first"),
      assistantEntry("2", "assistant reply"),
      userEntry("3", "user second"),
      assistantEntry("4", "another assistant reply"),
    ]
    expect(extractLastUserMessages(entries, 2)).toEqual([
      "user first",
      "user second",
    ])
  })

  it("returns all user messages when K exceeds the count", () => {
    const entries = [userEntry("1", "alpha"), userEntry("2", "beta")]
    expect(extractLastUserMessages(entries, 10)).toEqual(["alpha", "beta"])
  })

  it("returns an empty array when there are no user messages", () => {
    expect(
      extractLastUserMessages([assistantEntry("1", "hi")], 3),
    ).toEqual([])
  })

  it("returns an empty array for an empty input", () => {
    expect(extractLastUserMessages([], 3)).toEqual([])
  })

  it("concatenates multiple text parts within a single user message", () => {
    const entries = [multiPartUserEntry("1", ["part one", "part two"])]
    expect(extractLastUserMessages(entries, 1)).toEqual(["part one\npart two"])
  })

  it("skips non-text parts (they are absent from the text projection)", () => {
    const entry: MessageEntry = {
      info: {
        id: "1",
        sessionID: "sess_test",
        role: "user",
        time: { created: 0 },
        agent: "chat",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      } as MessageEntry["info"],
      parts: [
        {
          id: "p1",
          sessionID: "sess_test",
          messageID: "1",
          type: "text",
          text: "hello",
        } as MessageEntry["parts"][number],
        // A non-text part. The fetcher should ignore it.
        {
          id: "p2",
          sessionID: "sess_test",
          messageID: "1",
          type: "file",
          mime: "image/png",
          filename: "x.png",
        } as unknown as MessageEntry["parts"][number],
      ],
    }
    expect(extractLastUserMessages([entry], 1)).toEqual(["hello"])
  })

  it("returns empty when a user message has only non-text parts", () => {
    const entry: MessageEntry = {
      info: {
        id: "1",
        sessionID: "sess_test",
        role: "user",
        time: { created: 0 },
        agent: "chat",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      } as MessageEntry["info"],
      parts: [
        {
          id: "p1",
          sessionID: "sess_test",
          messageID: "1",
          type: "file",
          mime: "image/png",
          filename: "x.png",
        } as unknown as MessageEntry["parts"][number],
      ],
    }
    // Message had no text content, so it contributes nothing.
    expect(extractLastUserMessages([entry], 1)).toEqual([])
  })
})

describe("getLastUserMessages", () => {
  it("calls client.session.messages with the session id and returns extracted texts", async () => {
    const entries = [
      userEntry("1", "alpha"),
      userEntry("2", "beta"),
      userEntry("3", "gamma"),
    ]

    let receivedId: string | undefined
    const client = {
      session: {
        messages: async (opts: { path: { id: string } }) => {
          receivedId = opts.path.id
          return { data: entries }
        },
      },
    }

    const result = await getLastUserMessages(client as never, "sess_123", 2)
    expect(receivedId).toBe("sess_123")
    expect(result).toEqual(["beta", "gamma"])
  })

  it("returns an empty array if the client returns undefined data", async () => {
    const client = {
      session: {
        messages: async () => ({ data: undefined }),
      },
    }
    const result = await getLastUserMessages(client as never, "sess_x", 3)
    expect(result).toEqual([])
  })
})
