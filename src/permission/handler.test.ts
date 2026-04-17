import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../classifier/classify.ts", () => ({
  classifyCommand: vi.fn(),
}))
vi.mock("../ui/messages.ts", () => ({
  getLastUserMessages: vi.fn(),
}))
vi.mock("./safe-path.ts", () => ({
  runSafePath: vi.fn(),
}))
vi.mock("./risky-path.ts", () => ({
  runRiskyPathInBackground: vi.fn(),
}))

import { classifyCommand } from "../classifier/classify.ts"
import { getLastUserMessages } from "../ui/messages.ts"
import { runSafePath } from "./safe-path.ts"
import { runRiskyPathInBackground } from "./risky-path.ts"
import { handlePermission } from "./handler.ts"
import { DEFAULT_CONFIG } from "../config.ts"

const mockedClassify = vi.mocked(classifyCommand)
const mockedGetMsgs = vi.mocked(getLastUserMessages)
const mockedSafe = vi.mocked(runSafePath)
const mockedRisky = vi.mocked(runRiskyPathInBackground)

beforeEach(() => {
  mockedClassify.mockReset()
  mockedGetMsgs.mockReset()
  mockedSafe.mockReset()
  mockedRisky.mockReset()
  mockedGetMsgs.mockResolvedValue(["please check the repo"])
})

function basePermission(overrides: Record<string, unknown> = {}) {
  return {
    id: "perm_123",
    type: "bash",
    pattern: "git status",
    sessionID: "sess_abc",
    messageID: "msg_xyz",
    title: "Run bash command",
    metadata: {},
    time: { created: 0 },
    ...overrides,
  } as never
}

const baseCtx = {
  client: {} as never,
  config: DEFAULT_CONFIG,
  sessionModel: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
}

describe("handlePermission", () => {
  it("is a no-op when config.enabled is false", async () => {
    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(basePermission(), output, {
      ...baseCtx,
      config: { ...DEFAULT_CONFIG, enabled: false },
    })
    expect(output.status).toBe("ask")
    expect(mockedClassify).not.toHaveBeenCalled()
  })

  it("is a no-op for non-bash tool types", async () => {
    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(
      basePermission({ type: "edit" }),
      output,
      baseCtx,
    )
    expect(output.status).toBe("ask")
    expect(mockedClassify).not.toHaveBeenCalled()
  })

  it("sets output.status='allow' when SAFE and the safe-path returns allow", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "SAFE",
      reason: "read-only",
    })
    mockedSafe.mockResolvedValueOnce("allow")

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(basePermission(), output, baseCtx)

    expect(output.status).toBe("allow")
    expect(mockedSafe).toHaveBeenCalledTimes(1)
    expect(mockedRisky).not.toHaveBeenCalled()
  })

  it("sets output.status='ask' when SAFE but user cancelled", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "SAFE",
      reason: "read-only",
    })
    mockedSafe.mockResolvedValueOnce("ask")

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(basePermission(), output, baseCtx)

    expect(output.status).toBe("ask")
  })

  it("sets output.status='ask' when RISKY and starts risky path in background", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "RISKY",
      reason: "destructive",
    })
    mockedRisky.mockResolvedValue(undefined)

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(
      basePermission({ pattern: "rm -rf /" }),
      output,
      baseCtx,
    )

    expect(output.status).toBe("ask")
    expect(mockedRisky).toHaveBeenCalledTimes(1)
    // The permission handler must return promptly. The risky path call is
    // fire-and-forget; what we assert here is that it was scheduled.
    const args = mockedRisky.mock.calls[0]?.[0]
    expect(args?.sessionID).toBe("sess_abc")
    expect(args?.permissionID).toBe("perm_123")
    expect(args?.command).toBe("rm -rf /")
    expect(args?.reason).toBe("destructive")
  })

  it("sets output.status='ask' when the classifier fails (returns null)", async () => {
    mockedClassify.mockResolvedValueOnce(null)

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(basePermission(), output, baseCtx)

    expect(output.status).toBe("ask")
    expect(mockedSafe).not.toHaveBeenCalled()
    expect(mockedRisky).not.toHaveBeenCalled()
  })

  it("sets output.status='ask' when getLastUserMessages throws", async () => {
    mockedGetMsgs.mockRejectedValueOnce(new Error("sdk explode"))

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(basePermission(), output, baseCtx)

    expect(output.status).toBe("ask")
    expect(mockedClassify).not.toHaveBeenCalled()
  })

  it("extracts command from a string pattern", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "SAFE",
      reason: "r",
    })
    mockedSafe.mockResolvedValueOnce("allow")

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(
      basePermission({ pattern: "echo hi" }),
      output,
      baseCtx,
    )

    const args = mockedClassify.mock.calls[0]?.[0]
    expect(args?.command).toBe("echo hi")
  })

  it("extracts command from an array pattern (first element)", async () => {
    mockedClassify.mockResolvedValueOnce({
      verdict: "SAFE",
      reason: "r",
    })
    mockedSafe.mockResolvedValueOnce("allow")

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(
      basePermission({ pattern: ["ls -la", "/fallback"] }),
      output,
      baseCtx,
    )

    const args = mockedClassify.mock.calls[0]?.[0]
    expect(args?.command).toBe("ls -la")
  })

  it("sets output.status='ask' when pattern is missing (no command to classify)", async () => {
    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(
      basePermission({ pattern: undefined }),
      output,
      baseCtx,
    )
    expect(output.status).toBe("ask")
    expect(mockedClassify).not.toHaveBeenCalled()
  })

  it("passes config.contextMessageCount to getLastUserMessages", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(basePermission(), output, {
      ...baseCtx,
      config: { ...DEFAULT_CONFIG, contextMessageCount: 7 },
    })

    const callArgs = mockedGetMsgs.mock.calls[0]
    expect(callArgs?.[2]).toBe(7)
  })

  it("uses the resolved classifier model (config override wins)", async () => {
    mockedClassify.mockResolvedValueOnce({ verdict: "SAFE", reason: "r" })
    mockedSafe.mockResolvedValueOnce("allow")

    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(basePermission(), output, {
      ...baseCtx,
      config: {
        ...DEFAULT_CONFIG,
        classifierModel: "anthropic/claude-haiku-4-5",
      },
    })

    const args = mockedClassify.mock.calls[0]?.[0]
    expect(args?.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    })
  })

  it("fails closed when no classifier model can be resolved", async () => {
    const output = { status: "ask" as "ask" | "allow" | "deny" }
    await handlePermission(basePermission(), output, {
      ...baseCtx,
      sessionModel: undefined,
      config: { ...DEFAULT_CONFIG, classifierModel: undefined },
    })

    expect(output.status).toBe("ask")
    expect(mockedClassify).not.toHaveBeenCalled()
  })
})
