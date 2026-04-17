import { describe, it, expect } from "vitest"
import {
  resolveClassifierModel,
  PROVIDER_DEFAULT_SMALL_MODELS,
} from "./model.ts"

describe("resolveClassifierModel", () => {
  it("uses the explicit config override when set, ignoring session model", () => {
    expect(
      resolveClassifierModel({
        configOverride: "anthropic/claude-haiku-4-5",
        sessionModel: { providerID: "openai", modelID: "gpt-5" },
      }),
    ).toEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5" })
  })

  it("auto-detects anthropic → claude-haiku-4-5", () => {
    expect(
      resolveClassifierModel({
        configOverride: undefined,
        sessionModel: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      }),
    ).toEqual({
      providerID: "anthropic",
      modelID: PROVIDER_DEFAULT_SMALL_MODELS.anthropic,
    })
  })

  it("auto-detects openai → gpt-4.1-mini (or equivalent default)", () => {
    const resolved = resolveClassifierModel({
      configOverride: undefined,
      sessionModel: { providerID: "openai", modelID: "gpt-5" },
    })
    expect(resolved).toEqual({
      providerID: "openai",
      modelID: PROVIDER_DEFAULT_SMALL_MODELS.openai,
    })
  })

  it("auto-detects google → flash-class default", () => {
    const resolved = resolveClassifierModel({
      configOverride: undefined,
      sessionModel: { providerID: "google", modelID: "gemini-2.5-pro" },
    })
    expect(resolved).toEqual({
      providerID: "google",
      modelID: PROVIDER_DEFAULT_SMALL_MODELS.google,
    })
  })

  it("falls back to the session model when provider is unknown", () => {
    expect(
      resolveClassifierModel({
        configOverride: undefined,
        sessionModel: { providerID: "openrouter", modelID: "x-ai/grok-5" },
      }),
    ).toEqual({ providerID: "openrouter", modelID: "x-ai/grok-5" })
  })

  it("returns null when there is no override and no session model", () => {
    expect(
      resolveClassifierModel({
        configOverride: undefined,
        sessionModel: undefined,
      }),
    ).toBeNull()
  })

  it("rejects a malformed override (no slash) by returning null", () => {
    expect(
      resolveClassifierModel({
        configOverride: "claude-haiku-4-5",
        sessionModel: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      }),
    ).toBeNull()
  })

  it("accepts override with modelID that contains slashes (e.g. openrouter)", () => {
    // OpenRouter-style models like "anthropic/claude-haiku" have slashes; we
    // split on the first slash so the modelID can itself contain slashes.
    expect(
      resolveClassifierModel({
        configOverride: "openrouter/anthropic/claude-haiku",
        sessionModel: undefined,
      }),
    ).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-haiku",
    })
  })

  it("trims whitespace from the override", () => {
    expect(
      resolveClassifierModel({
        configOverride: "  anthropic/claude-haiku-4-5  ",
        sessionModel: undefined,
      }),
    ).toEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5" })
  })
})

describe("PROVIDER_DEFAULT_SMALL_MODELS", () => {
  it("has entries for the providers we auto-detect", () => {
    expect(PROVIDER_DEFAULT_SMALL_MODELS.anthropic).toBeDefined()
    expect(PROVIDER_DEFAULT_SMALL_MODELS.openai).toBeDefined()
    expect(PROVIDER_DEFAULT_SMALL_MODELS.google).toBeDefined()
  })
})
