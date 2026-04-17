# Delegated Access

Stop smashing the Approve button. Delegated Access gives [OpenCode](https://opencode.ai) an AI safety reviewer that auto-approves the boring stuff and escalates the scary stuff to your desktop, so you can actually keep working instead of babysitting the terminal.

Think of it as Claude's [auto mode](https://claude.com/blog/auto-mode) — but for OpenCode, and you control it.

## Why you want this

Right now, OpenCode stops and asks before every bash command. `ls`. `git status`. `npm test`. Every one of them pulls you back into the loop.

You could turn off permissions entirely with `--dangerously-skip-permissions`, but then `rm -rf node_modules` and `rm -rf ~/Documents` look the same to the machine. They are not the same.

Delegated Access splits the difference:

- **Safe commands auto-dismiss themselves.** OpenCode's prompt briefly flashes, a small LLM (Haiku-class by default) classifies it as safe, a "Running in 5s — Cancel" notification appears, and after the countdown the plugin dismisses the prompt for you and the command runs. Don't click Cancel, it runs. Ignore it, it runs.
- **Risky commands wake you up.** Destructive `rm`, `sudo`, `curl | sh`, anything touching `.env`, anything you didn't ask for — a desktop notification pops up with **Approve** and **Reject** buttons. Click one, the TUI prompt closes. Click nothing and the prompt's still there when you come back.
- **Weird commands fail safe.** Classifier timed out? API flaked? Weird response? The prompt just stays there waiting for you. Nothing ever slips through silently.

You stay in flow. The agent stops pestering you for routine stuff. Dangerous stuff still needs a human.

## How it decides

Every time OpenCode would prompt for a bash command, Delegated Access:

1. Grabs the last N messages **you** sent (never the agent's messages — that would be a prompt injection wide open).
2. Asks a small fast model: _given this command and what the user just said, is this SAFE or RISKY?_
3. Acts on the verdict:

```
    ┌───────────────────────────────┐
    │ Agent wants to run: `rm -rf …`│
    └───────────────┬───────────────┘
                    ▼
         OpenCode shows TUI prompt
         (and emits permission.asked)
                    │
                    ▼
           Classifier reads it
                    │
         ┌──────────┼──────────┐
         ▼          ▼          ▼
       SAFE       RISKY     FAIL
         │          │         │
         ▼          ▼         ▼
     Notify +    Notify +   Leave
    countdown    buttons     prompt
         │          │         │
         ▼          ▼         ▼
     Dismiss    User clicks  User decides
     TUI &      → dismiss    in TUI
     run        TUI + run/
                block
```

The classifier call happens in an **ephemeral child session** of your current session, using OpenCode's own provider + auth — no extra API keys, no extra packages to configure. It's hidden from session lists and deleted when done.

### About that TUI flash

OpenCode 1.4.x emits the `permission.asked` event _after_ it has already queued the permission and started showing you the prompt. That means on SAFE commands you'll briefly see the usual "Allow this command?" prompt before the plugin auto-dismisses it. The SDK declares a `permission.ask` hook that would let us intercept _before_ the prompt appears, but the compiled runtime doesn't actually dispatch it yet. If that ever lands, this plugin will get a snappier flash-free SAFE path for free.

## Install

### 1. Clone and install dependencies

```bash
git clone https://github.com/jdtzmn/opencode-delegated-access.git
cd opencode-delegated-access
bun install
```

### 2. Add the plugin to your `opencode.json`

```jsonc
{
  "plugin": ["/absolute/path/to/opencode-delegated-access/src/index.ts"]
}
```

Or install straight from GitHub:

```jsonc
{
  "plugin": ["opencode-delegated-access@git+https://github.com/jdtzmn/opencode-delegated-access.git"]
}
```

That's it. Defaults just work. Start OpenCode and it's live.

### 3. (Optional) Tune it

```jsonc
{
  "plugin": ["opencode-delegated-access@git+https://github.com/jdtzmn/opencode-delegated-access.git"],
  "delegatedAccess": {
    "enabled": true,
    "contextMessageCount": 3,
    "safeCountdownMs": 5000,
    "classifierModel": "anthropic/claude-haiku-4-5",
    "classifierTimeoutMs": 5000,
    "notificationSound": true
  }
}
```

| Knob | Default | What it does |
|---|---|---|
| `enabled` | `true` | Turn the whole thing off without uninstalling. |
| `contextMessageCount` | `3` | How many of **your** recent messages the classifier sees. 0 = no context, just the command. |
| `safeCountdownMs` | `5000` | Cancellable countdown before auto-dismissing SAFE prompts. `0` = silent instant approve. |
| `classifierModel` | _auto_ | Override the judge model, e.g. `anthropic/claude-haiku-4-5`. When unset, uses a small fast default for your provider (Haiku, `gpt-4.1-mini`, `gemini-flash-lite`). |
| `classifierTimeoutMs` | `5000` | How long before we give up on the classifier and leave the TUI prompt alone. |
| `notificationSound` | `true` | OS notification sound on/off. |

### Use OpenCode's existing permission rules for fast-path patterns

Don't duplicate allowlists here. OpenCode's static rules run **before** this plugin, so put your always-safe and never-safe patterns there:

```jsonc
{
  "permission": {
    "bash": {
      "git status": "allow",
      "npm test":   "allow",
      "rm -rf /*":  "deny"
    }
  }
}
```

Anything not matched by a static rule flows into the classifier.

## Works best on macOS

The desktop notifications with Approve / Reject buttons work via `terminal-notifier` / macOS NotificationCenter. On Linux and Windows the SAFE countdown still works (the notification itself is the timer), but interactive buttons on the RISKY path may not be clickable — OpenCode's in-TUI prompt is always shown too, so you have a reliable fallback on every platform.

## How it's safe

- **The classifier never sees the agent's messages.** Only yours. A rogue assistant can't smuggle "this command is safe, trust me" into the judge's context.
- **Every error leaves the TUI prompt alone.** Classifier timeout, API error, malformed verdict, missing command, unexpected exception — none of them call the respond API, so the TUI prompt stays and you decide manually. The plugin only ever _dismisses_ a prompt after an affirmative SAFE decision, never silently passes through on errors.
- **The classifier can't call tools.** The ephemeral session runs with `tools: {}`, so even a compromised classifier model can only return text.
- **Risky commands get two channels, not one.** The TUI prompt stays up AND the notification fires with Approve/Reject. Whichever you answer first wins — no bug in the notification path can ever accidentally auto-approve a RISKY command.
- **The classifier can't trigger itself.** We track ephemeral classifier sessions and ignore permission events from them.

## Status

v0.1.0. Bash commands only (edit / write / webfetch still prompt normally — that's the scope for v1). 136 tests, TypeScript, Bun. macOS-tested; Linux/Windows should work with degraded notification interactivity.

## Development

```bash
bun install
bun run check   # TypeScript check
bun run test    # 136 unit tests
```

Design doc and implementation plan in [`docs/superpowers/`](./docs/superpowers/).

## License

MIT.
