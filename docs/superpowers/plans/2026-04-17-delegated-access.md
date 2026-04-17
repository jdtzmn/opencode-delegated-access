# Delegated Access Implementation Plan

> **For agentic workers:** Plan executed inline in the build session. Each phase is committed separately with TDD where practical.

**Goal:** Ship an OpenCode plugin that uses an LLM safety classifier to auto-approve safe bash commands and escalate risky ones via OS notifications.

**Architecture:** In-process plugin; `permission.ask` hook runs a classifier via an ephemeral OpenCode session (`session.create` → `session.prompt` with `tools: {}` → `session.delete`), then dispatches to SAFE (countdown + cancel) or RISKY (dual-channel TUI + notification) path. Fail-closed on any classifier error.

**Tech Stack:** TypeScript, `@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod`, `node-notifier`, `vitest`.

---

## Phases

Each phase ends with a commit. Smallest relevant validation runs before each commit.

1. **Project scaffolding** — `package.json`, `tsconfig.json`, `.gitignore`, vitest config, empty `src/index.ts`. Verify: `bun run check` passes on an empty module.
2. **Config schema** — `src/config.ts` with Zod schema + `src/config.test.ts`. Verify: tests pass.
3. **Response parser** — `src/classifier/parse.ts` + tests. Accepts well-formed responses, returns null for malformed.
4. **Classifier prompt builder** — `src/classifier/prompt.ts` + tests. Pure functions, no I/O.
5. **Model resolver** — `src/classifier/model.ts` + tests. Config override → provider auto-detect → session-model fallback.
6. **Session messages fetcher** — `src/ui/messages.ts` + tests. Filters to user messages, respects K.
7. **Classifier orchestrator** — `src/classifier/classify.ts` + tests. Uses ephemeral session; timeout via `AbortSignal`; cleanup in `finally`.
8. **HTTP callback server** — `src/notify/callback-server.ts` + tests. Random port + token; first hit wins.
9. **Notification wrapper** — `src/notify/notify.ts` + tests. Thin wrapper around `node-notifier` with action URLs.
10. **SAFE path** — `src/permission/safe-path.ts` + tests. Race countdown vs callback.
11. **RISKY path** — `src/permission/risky-path.ts` + tests. Dual-channel; fire-and-forget on SDK resolve.
12. **Plugin entry** — `src/index.ts` wires everything to `permission.ask`. Integration test with mocked client.
13. **README + smoke** — Usage docs; manual smoke test on a real session.

## Deferred decisions (resolved during implementation, documented as they're made)

- Exact plugin config injection shape from OpenCode's `config` hook
- Exact SDK method to respond to a permission on the user's behalf
- `node-notifier` action-button API details on macOS vs degraded platforms
