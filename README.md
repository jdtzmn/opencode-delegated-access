# Delegated Access

Stop smashing the Approve button. Delegated Access gives [OpenCode](https://opencode.ai) an AI safety reviewer that auto-approves the boring stuff and escalates the scary stuff to your desktop, so you can actually keep working instead of babysitting the terminal.

Think of it as Claude's [auto mode](https://claude.com/blog/auto-mode) — but for OpenCode, and you control it.

## Why you want this

Right now, OpenCode stops and asks before every bash command. `ls`. `git status`. `npm test`. Every one of them pulls you back into the loop.

You could turn off permissions entirely with `--dangerously-skip-permissions`, but then `rm -rf node_modules` and `rm -rf ~/Documents` look the same to the machine. They are not the same.

Delegated Access splits the difference:

- **Safe commands auto-dismiss themselves.** OpenCode's prompt briefly flashes, a small LLM (Haiku-class by default) classifies it as safe, a "Running in 5s — Cancel" notification appears, and after the countdown the plugin dismisses the prompt for you and the command runs. Don't click Cancel, it runs. Ignore it, it runs.
- **External directory access is handled the same way.** When the agent wants to read or write outside the current project (e.g. a sibling repo you just mentioned), the same classifier decides whether your recent messages justify it — no extra config needed.
- **Risky commands wake you up.** Destructive `rm`, `sudo`, `curl | sh`, anything touching `.env`, anything you didn't ask for — a desktop notification pops up with **Approve** and **Reject** buttons. Click one, the TUI prompt closes. Click nothing and the prompt's still there when you come back.
- **Weird commands fail safe.** Classifier timed out? API flaked? Weird response? The prompt just stays there waiting for you. Nothing ever slips through silently.

You stay in flow. The agent stops pestering you for routine stuff. Dangerous stuff still needs a human.

## How it decides

Every time OpenCode would prompt for a bash command **or an external directory access**, Delegated Access:

1. Finds the root session. If the permission fired inside a subagent, walks up `parentID` to where _you_ actually typed.
2. Grabs the last N messages **you** sent from that root session (never the agent's messages, never a parent agent's dispatch prompt to a subagent — that would be a prompt injection wide open).
3. Sniffs the current git state — branch name, and (via `gh`) the PR number/title linked to that branch if there's an open PR. Helps the classifier judge commands that target specific PRs (e.g. `gh pr comment 123`).
4. Asks a small fast model: _given this command / directory, what the user just said, and the current branch + PR, is this SAFE or RISKY?_
5. Acts on the verdict:

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

Use the **per-plugin tuple form** — `[pluginSpec, optionsObject]` — to pass options to the plugin. This is the schema-blessed mechanism in OpenCode and avoids the unknown-top-level-key startup error.

```jsonc
{
  "plugin": [
    [
      "opencode-delegated-access@git+https://github.com/jdtzmn/opencode-delegated-access.git",
      {
        "enabled": true,
        "contextMessageCount": 3,
        "safeCountdownMs": 5000,
        "classifierModel": "anthropic/claude-haiku-4-5",
        "classifierTimeoutMs": 15000,
        "notificationSound": true,
        "externalDirectoryEnabled": true,
        "directoryVerdictCacheTtlMs": 60000,
        "approvalHistoryEnabled": true,
        "approvalHistoryMax": 20
      }
    ]
  ]
}
```

> **Migrating from older configs:** previous versions of this README documented a top-level `delegatedAccess` object. That form is **no longer supported** — OpenCode rejects unknown top-level keys at startup. Move your settings into the tuple form shown above.

| Knob | Default | What it does |
|---|---|---|
| `enabled` | `true` | Turn the whole thing off without uninstalling. |
| `contextMessageCount` | `3` | How many of **your** recent messages the classifier sees. 0 = no context, just the command. |
| `safeCountdownMs` | `5000` | Cancellable countdown before auto-dismissing SAFE prompts. `0` = silent instant approve. |
| `classifierModel` | _auto_ | Override the judge model, e.g. `anthropic/claude-haiku-4-5`. When unset, uses a small fast default for your provider (Haiku, `gpt-5.4-mini`, `gemini-flash-lite`). |
| `classifierTimeoutMs` | `15000` | How long before we give up on the classifier and leave the TUI prompt alone. |
| `notificationSound` | `true` | OS notification sound on/off. |
| `externalDirectoryEnabled` | `true` | Also classify `external_directory` permissions (directory access outside the current project). Set to `false` to restrict the plugin to bash commands only. |
| `directoryVerdictCacheTtlMs` | `60000` | How long (ms) a SAFE directory verdict is cached. Covers rapid burst requests (agent walking a tree) without re-classifying each sub-path individually. `0` disables the cache. |
| `approvalHistoryEnabled` | `true` | Remember each human Approve/Reject decision made via the OpenCode TUI or our notification, and surface recent ones to the classifier as prior-decision context. Session-scoped, in-memory only. |
| `approvalHistoryMax` | `20` | Per-session cap on how many recent human decisions the classifier sees. `0` disables playback (entries are still recorded; just not surfaced). |

### Use OpenCode's existing permission rules for fast-path patterns

Don't duplicate allowlists here. OpenCode's static rules run **before** this plugin, so put your always-safe and never-safe patterns there:

```jsonc
{
  "permission": {
    "bash": {
      "git status": "allow",
      "npm test":   "allow",
      "rm -rf /*":  "deny"
    },
    "external_directory": {
      "/tmp/**": "allow"
    }
  }
}
```

Anything not matched by a static rule flows into the classifier.

## Works best on macOS

The desktop notifications with Approve / Reject buttons work via `terminal-notifier` / macOS NotificationCenter. On Linux and Windows the SAFE countdown still works (the notification itself is the timer), but interactive buttons on the RISKY path may not be clickable — OpenCode's in-TUI prompt is always shown too, so you have a reliable fallback on every platform.

## How it's safe

- **The classifier never sees the agent's messages.** Only yours. A rogue assistant can't smuggle "this command is safe, trust me" into the judge's context. Same for directory access — the classifier answers "did the human's recent messages justify this path?" not "does the agent think it's safe?"
- **Subagents don't weaken that.** When a permission fires inside a subagent session, the plugin walks up the session tree to the root and pulls _your_ messages from there — never the dispatching agent's prompt to the subagent. If the tree can't be verified (SDK error, unexpected cycle, too deep) the plugin fails closed and leaves the TUI prompt for you. Even on the root session, user-role messages are filtered to the root's primary agent so synthetic "user" turns addressed elsewhere never leak in.
- **Every error leaves the TUI prompt alone.** Classifier timeout, API error, malformed verdict, missing subject, session-tree lookup failure, unexpected exception — none of them call the respond API, so the TUI prompt stays and you decide manually. The plugin only ever _dismisses_ a prompt after an affirmative SAFE decision, never silently passes through on errors.
- **The classifier can't call tools.** The ephemeral session runs with `tools: { "*": false }`, so even a compromised classifier model can only return text.
- **Risky commands and risky directory requests get two channels, not one.** The TUI prompt stays up AND the notification fires with Approve/Reject. Whichever you answer first wins — no bug in the notification path can ever accidentally auto-approve a RISKY request.
- **The classifier can't trigger itself.** We track ephemeral classifier sessions and ignore permission events from them.
- **The directory cache only speeds things up; it can't change a RISKY verdict.** Only SAFE verdicts are cached. A RISKY verdict for any path always triggers the escalation notification — the cache only deduplicates rapid burst requests for a path that was already classified SAFE.
- **Repo context is best-effort and gracefully optional.** Branch is read with `git`; the open-PR lookup uses `gh`. If `gh` isn't installed, isn't authenticated, or the working directory isn't a git repo, the classifier just runs without that context — never blocks. The PR title is rendered inside `<repo_context>` delimiters and treated as data (not instructions) by the classifier.

## Session approval history

If you Approve or Reject a permission in this session — either via OpenCode's TUI prompt or via the desktop notification's buttons — Delegated Access remembers your decision. The next time a similar request comes up, the classifier sees a brief `<prior_human_approvals>` block in its prompt summarising what you previously decided in this session, and may use that as evidence to lean toward your earlier judgment.

A few important properties of how this works:

- **Session-scoped only.** The history lives in memory for the lifetime of the OpenCode session group and is never written to disk. Closing OpenCode discards it.
- **Pure human signal.** When the classifier auto-approves a SAFE command, that decision is NOT recorded — only your explicit Approve/Reject clicks are. The history is the record of what _you_ decided, not what the classifier decided for you.
- **Hard-RISKY categories still escalate.** Prior approvals don't override the destructive / privilege-escalation / credential-access categories. Approving `git status` 30 times doesn't teach the classifier to wave through `sudo rm -rf /`.
- **Captures every channel.** Decisions made via the TUI (clicking Approve in OpenCode's prompt), the desktop notification (clicking Approve in our `terminal-notifier` popup), or OpenCode's CLI/keyboard shortcuts all flow through the same `permission.replied` event and are captured identically.
- **Disable with `approvalHistoryEnabled: false`** in your config if you'd rather every classification be independent.

## Status

v0.3.0. Bash commands and external directory access, with per-session approval history that lets the classifier learn from your prior in-session decisions. Edit / write / webfetch still prompt normally — those are out of scope. TypeScript, Bun. macOS-tested; Linux/Windows should work with degraded notification interactivity.

## Development

```bash
bun install
bun run check   # TypeScript check
bun run test    # full unit-test suite
```

Design doc and implementation plan in [`docs/superpowers/`](./docs/superpowers/).

## License

MIT.
