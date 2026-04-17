# opencode-delegated-access

An OpenCode plugin that auto-approves safe bash commands using an LLM safety classifier, and escalates risky ones via an interactive OS notification.

Inspired by [Claude's auto mode](https://claude.com/blog/auto-mode).

**Status:** early development. See [`docs/superpowers/specs/`](./docs/superpowers/specs/) for the design spec.

## How it works

When OpenCode would normally prompt you to approve a bash command:

1. The plugin intercepts the approval
2. A small, fast LLM (Haiku-class) classifies the command as SAFE or RISKY, given the command and the last few messages you sent
3. **SAFE** → you get an OS notification ("Running `<cmd>` in 5s — click to cancel"); if you don't cancel, the command runs automatically
4. **RISKY** → the usual TUI approval prompt appears AND a notification with Approve / Reject buttons; whichever you act on first wins
5. **Classifier failure** → falls back to the normal TUI prompt (fail closed)

Only bash commands are classified. Other tool types prompt normally.

## Install

_(Coming in a later phase.)_
