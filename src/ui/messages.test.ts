import { describe, it, expect } from "vitest"
import {
  extractLastUserMessages,
  extractLatestAssistantModel,
  extractRootAgent,
  getLastUserMessages,
  getSessionMessages,
  sanitizeUserMessageForClassifier,
  CLASSIFIER_MESSAGE_MAX_CHARS,
} from "./messages.ts"
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

/**
 * Build a user entry whose `info.agent` is the given value. Used to
 * exercise the agent-filter path: the classifier should only see user
 * messages whose agent matches the root session's primary agent.
 */
function userEntryWithAgent(
  id: string,
  text: string,
  agent: string,
): MessageEntry {
  return {
    info: {
      id,
      sessionID: "sess_test",
      role: "user",
      time: { created: 0 },
      agent,
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

  it("sanitizes injected blocks out of each returned message", () => {
    const entries = [
      userEntry("1", "<pr_context>huge</pr_context>do the rename"),
      userEntry("2", "plain request"),
    ]
    expect(extractLastUserMessages(entries, 2)).toEqual([
      "do the rename",
      "plain request",
    ])
  })

  it("drops a user message that becomes empty after sanitization", () => {
    // A pure pr_context injection contributes nothing once stripped, so it
    // must not appear as an empty string (and must not consume a K slot).
    const entries = [
      userEntry("1", "<pr_context>only injected content</pr_context>"),
      userEntry("2", "real one"),
      userEntry("3", "real two"),
    ]
    expect(extractLastUserMessages(entries, 2)).toEqual(["real one", "real two"])
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

describe("sanitizeUserMessageForClassifier", () => {
  it("returns clean prose unchanged", () => {
    const text = "please refactor the auth module and run the tests"
    expect(sanitizeUserMessageForClassifier(text)).toBe(text)
  })

  it("strips a premind <pr_context> block but keeps surrounding prose", () => {
    const text =
      "reply on the PR\n<pr_context>\n<pr_meta>{...huge json...}</pr_meta>\n</pr_context>\nthanks"
    const out = sanitizeUserMessageForClassifier(text)
    expect(out).not.toMatch(/<pr_context>/)
    expect(out).not.toMatch(/pr_meta/)
    expect(out).toContain("reply on the PR")
    expect(out).toContain("thanks")
  })

  it("strips a superpowers <EXTREMELY_IMPORTANT> preamble", () => {
    const text =
      "<EXTREMELY_IMPORTANT>\nYou have superpowers. You MUST invoke skills...\n</EXTREMELY_IMPORTANT>\nmake the decider more lenient"
    const out = sanitizeUserMessageForClassifier(text)
    expect(out).not.toMatch(/EXTREMELY_IMPORTANT/)
    expect(out).not.toMatch(/superpowers/)
    expect(out).toContain("make the decider more lenient")
  })

  it("strips the hyphenated <EXTREMELY-IMPORTANT> variant", () => {
    const text =
      "<EXTREMELY-IMPORTANT>\nrules here\n</EXTREMELY-IMPORTANT>\nactual request"
    const out = sanitizeUserMessageForClassifier(text)
    expect(out).not.toMatch(/EXTREMELY-IMPORTANT/)
    expect(out).toContain("actual request")
  })

  it("strips <system-reminder> blocks", () => {
    const text =
      "do the thing\n<system-reminder>\nMode changed to build.\n</system-reminder>"
    const out = sanitizeUserMessageForClassifier(text)
    expect(out).not.toMatch(/system-reminder/)
    expect(out).not.toMatch(/Mode changed/)
    expect(out).toContain("do the thing")
  })

  it("strips <SUBAGENT-STOP> and <available_skills> blocks", () => {
    const text =
      "<SUBAGENT-STOP>\nskip\n</SUBAGENT-STOP>\nreal\n<available_skills>\n<skill>x</skill>\n</available_skills>"
    const out = sanitizeUserMessageForClassifier(text)
    expect(out).not.toMatch(/SUBAGENT-STOP/)
    expect(out).not.toMatch(/available_skills/)
    expect(out).toContain("real")
  })

  it("strips multiple blocks of different kinds in one message", () => {
    const text =
      "<EXTREMELY_IMPORTANT>a</EXTREMELY_IMPORTANT>command me<pr_context>b</pr_context>"
    const out = sanitizeUserMessageForClassifier(text)
    expect(out).not.toMatch(/EXTREMELY_IMPORTANT|pr_context/)
    expect(out).toContain("command me")
  })

  it("strips an UNCLOSED block to end-of-string (truncated injection)", () => {
    const text = "real request\n<pr_context>\n<pr_meta>{ huge json that got cut off"
    const out = sanitizeUserMessageForClassifier(text)
    expect(out).not.toMatch(/pr_context|pr_meta/)
    expect(out).toContain("real request")
  })

  it("is case-insensitive on tag names", () => {
    const text = "<Pr_Context>x</Pr_Context>keep me"
    const out = sanitizeUserMessageForClassifier(text)
    expect(out.toLowerCase()).not.toMatch(/pr_context/)
    expect(out).toContain("keep me")
  })

  it("returns an empty string when the message is ONLY an injected block", () => {
    const text = "<pr_context>\n<pr_meta>{...}</pr_meta>\n</pr_context>"
    expect(sanitizeUserMessageForClassifier(text)).toBe("")
  })

  it("caps an over-long message at CLASSIFIER_MESSAGE_MAX_CHARS", () => {
    const long = "x".repeat(CLASSIFIER_MESSAGE_MAX_CHARS + 5000)
    const out = sanitizeUserMessageForClassifier(long)
    expect(out.length).toBeLessThanOrEqual(CLASSIFIER_MESSAGE_MAX_CHARS)
  })

  it("does not cap a message at or below the limit", () => {
    const ok = "y".repeat(CLASSIFIER_MESSAGE_MAX_CHARS - 100)
    expect(sanitizeUserMessageForClassifier(ok)).toBe(ok)
  })

  it("applies the cap AFTER stripping (a huge pr_context doesn't consume the budget)", () => {
    // A short real request followed by a massive pr_context block. After
    // stripping, the result is well under the cap and fully preserved.
    const realRequest = "rename the helper and commit"
    const text = realRequest + "<pr_context>" + "j".repeat(500_000) + "</pr_context>"
    const out = sanitizeUserMessageForClassifier(text)
    expect(out).toBe(realRequest)
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

describe("getSessionMessages", () => {
  it("returns the raw entries from client.session.messages", async () => {
    const entries = [userEntry("1", "alpha"), assistantEntry("2", "reply")]
    let receivedId: string | undefined
    const client = {
      session: {
        messages: async (opts: { path: { id: string } }) => {
          receivedId = opts.path.id
          return { data: entries }
        },
      },
    }

    const result = await getSessionMessages(client as never, "sess_abc")
    expect(receivedId).toBe("sess_abc")
    expect(result).toEqual(entries)
  })

  it("returns an empty array when data is undefined", async () => {
    const client = {
      session: { messages: async () => ({ data: undefined }) },
    }
    const result = await getSessionMessages(client as never, "sess_x")
    expect(result).toEqual([])
  })
})

describe("extractLatestAssistantModel", () => {
  it("returns provider+model from the latest assistant message", () => {
    const entries = [
      userEntry("u1", "hi"),
      assistantEntry("a1", "hello"),
      userEntry("u2", "thanks"),
    ]
    expect(extractLatestAssistantModel(entries)).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
  })

  it("returns the MOST RECENT assistant's model when multiple exist", () => {
    const older = assistantEntry("a_old", "older")
    const newer: MessageEntry = {
      info: {
        ...(older.info as unknown as Record<string, unknown>),
        id: "a_new",
        providerID: "openai",
        modelID: "gpt-4.1-mini",
      } as MessageEntry["info"],
      parts: [
        {
          id: "part_a_new",
          sessionID: "sess_test",
          messageID: "a_new",
          type: "text",
          text: "newer",
        } as MessageEntry["parts"][number],
      ],
    }
    const entries = [older, userEntry("u1", "more"), newer]
    expect(extractLatestAssistantModel(entries)).toEqual({
      providerID: "openai",
      modelID: "gpt-4.1-mini",
    })
  })

  it("returns null for an empty input", () => {
    expect(extractLatestAssistantModel([])).toBeNull()
  })

  it("returns null when there are no assistant messages", () => {
    const entries = [userEntry("u1", "a"), userEntry("u2", "b")]
    expect(extractLatestAssistantModel(entries)).toBeNull()
  })

  it("skips assistants with non-string model fields and keeps searching older entries", () => {
    const bad: MessageEntry = {
      info: {
        id: "a_bad",
        sessionID: "sess_test",
        role: "assistant",
        providerID: 42, // not a string
        modelID: undefined,
      } as unknown as MessageEntry["info"],
      parts: [],
    }
    const good = assistantEntry("a_good", "ok")
    // `good` comes before `bad` chronologically but `bad` is latest and must be
    // skipped; we then fall back to `good`.
    const entries = [good, bad]
    expect(extractLatestAssistantModel(entries)).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
  })

  it("returns null when every assistant has unusable model fields", () => {
    const bad: MessageEntry = {
      info: {
        id: "a_bad",
        sessionID: "sess_test",
        role: "assistant",
      } as unknown as MessageEntry["info"],
      parts: [],
    }
    expect(extractLatestAssistantModel([userEntry("u1", "x"), bad])).toBeNull()
  })
})

describe("extractRootAgent", () => {
  it("returns the agent of the earliest user message", () => {
    // The earliest user message is authoritative: it's the human's
    // opening turn with the primary agent.
    const entries = [
      userEntryWithAgent("u1", "first", "build"),
      assistantEntry("a1", "reply"),
      userEntryWithAgent("u2", "second", "build"),
    ]
    expect(extractRootAgent(entries)).toBe("build")
  })

  it("returns the earliest user's agent even when later user messages differ", () => {
    // Defense-in-depth: if a session contains later user messages with
    // different `agent` values (e.g. synthetic dispatches), the earliest
    // one still wins because it was the real human's first turn.
    const entries = [
      userEntryWithAgent("u1", "human first", "build"),
      userEntryWithAgent("u2", "dispatched later", "general"),
    ]
    expect(extractRootAgent(entries)).toBe("build")
  })

  it("ignores assistant messages", () => {
    const entries = [
      assistantEntry("a1", "synthetic assistant greeting"),
      userEntryWithAgent("u1", "real first", "chat"),
    ]
    expect(extractRootAgent(entries)).toBe("chat")
  })

  it("returns null when there are no user messages", () => {
    expect(extractRootAgent([])).toBeNull()
    expect(extractRootAgent([assistantEntry("a1", "hi")])).toBeNull()
  })

  it("returns null when the earliest user message lacks a string agent", () => {
    // Defensive: if the SDK shape drifts and `agent` is missing or
    // non-string, skip it and keep looking.
    const bad: MessageEntry = {
      info: {
        id: "u_bad",
        sessionID: "sess_test",
        role: "user",
        time: { created: 0 },
        // agent intentionally missing
      } as unknown as MessageEntry["info"],
      parts: [
        {
          id: "p_bad",
          sessionID: "sess_test",
          messageID: "u_bad",
          type: "text",
          text: "hi",
        } as MessageEntry["parts"][number],
      ],
    }
    const good = userEntryWithAgent("u_good", "later", "build")
    // Earliest is the bad one → keeps looking → finds good.
    expect(extractRootAgent([bad, good])).toBe("build")
  })

  it("returns null when every user message has a missing agent", () => {
    const bad: MessageEntry = {
      info: {
        id: "u_bad",
        sessionID: "sess_test",
        role: "user",
        time: { created: 0 },
      } as unknown as MessageEntry["info"],
      parts: [],
    }
    expect(extractRootAgent([bad])).toBeNull()
  })
})

describe("extractLastUserMessages with rootAgent filter", () => {
  it("returns all user messages when rootAgent is undefined (backward-compat)", () => {
    // This is the existing behavior: no filter applied.
    const entries = [
      userEntryWithAgent("u1", "hello", "build"),
      userEntryWithAgent("u2", "world", "general"),
    ]
    expect(extractLastUserMessages(entries, 10)).toEqual(["hello", "world"])
  })

  it("drops user messages whose agent does not match rootAgent", () => {
    const entries = [
      userEntryWithAgent("u1", "build-human-1", "build"),
      userEntryWithAgent("u2", "dispatched", "general"),
      userEntryWithAgent("u3", "build-human-2", "build"),
    ]
    expect(extractLastUserMessages(entries, 10, "build")).toEqual([
      "build-human-1",
      "build-human-2",
    ])
  })

  it("applies the K slice AFTER agent filtering", () => {
    // 4 build messages and 4 non-build. K=2 against the FILTERED list.
    const entries = [
      userEntryWithAgent("u1", "b1", "build"),
      userEntryWithAgent("u2", "x1", "general"),
      userEntryWithAgent("u3", "b2", "build"),
      userEntryWithAgent("u4", "x2", "general"),
      userEntryWithAgent("u5", "b3", "build"),
      userEntryWithAgent("u6", "x3", "general"),
      userEntryWithAgent("u7", "b4", "build"),
      userEntryWithAgent("u8", "x4", "general"),
    ]
    expect(extractLastUserMessages(entries, 2, "build")).toEqual(["b3", "b4"])
  })

  it("returns an empty array when no user messages match rootAgent", () => {
    const entries = [
      userEntryWithAgent("u1", "x1", "general"),
      userEntryWithAgent("u2", "x2", "general"),
    ]
    expect(extractLastUserMessages(entries, 10, "build")).toEqual([])
  })

  it("returns an empty array when K is 0 even with a rootAgent", () => {
    const entries = [userEntryWithAgent("u1", "build-only", "build")]
    expect(extractLastUserMessages(entries, 0, "build")).toEqual([])
  })

  it("still skips user messages with empty text after filtering", () => {
    // Existing behavior: no-text messages are dropped. The filter
    // shouldn't resurrect them.
    const noText: MessageEntry = {
      info: {
        id: "u_empty",
        sessionID: "sess_test",
        role: "user",
        time: { created: 0 },
        agent: "build",
      } as MessageEntry["info"],
      parts: [], // no text parts
    }
    const entries = [
      noText,
      userEntryWithAgent("u1", "real", "build"),
    ]
    expect(extractLastUserMessages(entries, 10, "build")).toEqual(["real"])
  })

  it("drops user messages whose `info.agent` is missing even when rootAgent is set", () => {
    // Fail-closed on unknown agent: if the field is missing, we can't
    // verify it's the human's primary agent, so exclude it.
    const missingAgent: MessageEntry = {
      info: {
        id: "u_missing",
        sessionID: "sess_test",
        role: "user",
        time: { created: 0 },
        // agent intentionally missing
      } as unknown as MessageEntry["info"],
      parts: [
        {
          id: "p_missing",
          sessionID: "sess_test",
          messageID: "u_missing",
          type: "text",
          text: "suspicious",
        } as MessageEntry["parts"][number],
      ],
    }
    const entries = [
      missingAgent,
      userEntryWithAgent("u1", "legit", "build"),
    ]
    expect(extractLastUserMessages(entries, 10, "build")).toEqual(["legit"])
  })
})
