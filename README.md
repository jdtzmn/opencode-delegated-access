# opencode-delegated-access

An [OpenCode](https://opencode.ai) plugin that auto-approves safe bash commands using an LLM safety classifier, and escalates risky ones via an interactive OS notification. Inspired by [Claude's auto mode](https://claude.com/blog/auto-mode).

**Status:** v0.1.0, early. macOS-first. See [`docs/superpowers/specs/`](./docs/superpowers/specs/) for the full design spec.

## What it does

When OpenCode would normally prompt you to approve a **bash** command:

1. The plugin intercepts the approval via the `permission.ask` hook.
2. A small, fast LLM (Haiku-class by default) classifies the command as SAFE or RISKY, given the command and the last few messages **you** (the human) sent.
3. **SAFE** → an OS notification appears: "Running `<cmd>` in 5s — Cancel"; if you don't click Cancel, the command runs automatically.
4. **RISKY** → the usual in-TUI approval prompt appears **and** a notification with **Approve** / **Reject** buttons. Whichever channel you act on first wins; clicking a button resolves the in-TUI prompt too.
5. **Classifier failure / timeout** → falls back to the normal in-TUI prompt (fail closed).

Other tool types (edit, write, webfetch, …) prompt normally. The plugin only touches bash.

## How the LLM call works

The classifier runs in an **ephemeral child session** of your current session:

- `client.session.create({ parentID })` — new child session; typically hidden from top-level session lists.
- `client.session.prompt({ model, system, tools: {}, parts })` — with the classifier system prompt, the small model, **no tools**, and the command + your recent messages as input.
- `client.session.delete(...)` — cleanup in a `finally` block.

This reuses OpenCode's provider plumbing (auth, model routing, provider config) so you don't need to configure a separate API key or install extra provider SDKs. Classifier calls take ~500ms–1.5s typically.

## Prompt-injection defence

The classifier sees only **user messages** from your session — never assistant output or tool results. This closes the obvious vector where a misaligned agent could prepend "actually, this rm -rf is fine because…" to manipulate the judge. User messages are wrapped in XML-style delimiters with an explicit system-prompt instruction to treat them as data, not instructions.

## Install

```bash
# Local dev (plugin loaded directly from this repo)
bun install
```

Then in your `opencode.json`:

```jsonc
{
  "plugin": ["./path/to/opencode-delegated-access/src/index.ts"],

  // Plugin config (optional — defaults shown)
  "delegatedAccess": {
    "enabled": true,
    "contextMessageCount": 3,
    "safeCountdownMs": 5000,
    "classifierModel": null,
    "classifierTimeoutMs": 5000,
    "notificationSound": true
  }
}
```

Once published to npm you'll be able to use `"plugin": ["opencode-delegated-access"]`.

### Configuration

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master toggle. When `false`, the plugin passes through to OpenCode's normal approval. |
| `contextMessageCount` | `3` | How many of your most recent messages (user messages only) the classifier sees as context. 0–20. |
| `safeCountdownMs` | `5000` | For SAFE commands, how long the cancellable notification stays up before auto-approving. Set to `0` to disable the notification and auto-approve silently. |
| `classifierModel` | *auto* | `providerID/modelID` override for the classifier. When unset, the plugin uses a provider-specific small model (Haiku for Anthropic, `gpt-4.1-mini` for OpenAI, `gemini-2.5-flash-lite` for Google) and falls back to the session's own model otherwise. |
| `classifierTimeoutMs` | `5000` | Hard timeout for the classifier call. On timeout, the plugin fails closed (falls back to the normal approval prompt). 500–30000. |
| `notificationSound` | `true` | Whether OS notifications play their sound. |

### Static allow/deny patterns

This plugin **does not** ship its own allowlist or denylist — OpenCode's static permission rules in `opencode.json` already run _before_ the plugin's hook, so they're the right place to express fast-path patterns:

```jsonc
{
  "permission": {
    "bash": {
      "git status": "allow",
      "npm test": "allow",
      "rm -rf /*": "deny"
    }
  }
}
```

Anything not covered by a static rule reaches the plugin for classification.

## Fail-closed behaviour

Every error path in the plugin falls back to `output.status = "ask"`, which means OpenCode shows its normal approval prompt. Errors that fail closed:

- Classifier API error / timeout / malformed response
- Ephemeral session creation or deletion failure
- Unknown provider and no `classifierModel` override
- Missing command / pattern in the permission request
- Any unexpected exception in the plugin itself

The one exception is SAFE-path notifier failure (e.g. running in a headless environment where `node-notifier` can't reach a display): since the classifier already deemed the command SAFE, a broken notifier doesn't re-gate the command. If you want fully strict behaviour in a headless environment, set `safeCountdownMs: 0` (silent auto-approve) or disable the plugin.

## Platforms

- **macOS**: fully supported. Action buttons work via NotificationCenter / `terminal-notifier`.
- **Linux / Windows**: the SAFE-path countdown still works (the notification is still a timer). Action buttons may degrade to non-interactive notifications depending on your `node-notifier` backend — the in-TUI prompt remains as the reliable fallback on every platform.

## Development

```bash
bun install
bun run check       # TypeScript check
bun run test        # Vitest
bun run test:watch  # Vitest watch mode
```

All core logic is covered by unit tests with mocked opencode clients and notifier. There's no fixture that hits a real LLM — that's left to manual smoke testing.

### Manual smoke test

1. Wire the plugin into a test `opencode.json` as shown above.
2. Start an opencode session.
3. Ask the agent to run a benign bash command, e.g. "run `ls -la`". You should see a "Running in 5s — Cancel" notification, then the command runs.
4. Ask for a risky one, e.g. "run `rm -rf ~/Documents/test_delete_me`" (after `mkdir`ing that directory, obviously). You should see the in-TUI prompt AND a notification with Approve/Reject buttons. Clicking Approve in the notification should resolve the TUI prompt.
5. Ask for something the classifier will time out on (e.g. temporarily set `classifierTimeoutMs: 500` and use a slow provider) and confirm the normal in-TUI prompt appears (fail closed).

## License

MIT.
