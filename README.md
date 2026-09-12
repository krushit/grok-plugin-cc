# Grok plugin for Claude Code

Use Grok from inside Claude Code for code reviews or to delegate tasks to Grok.

This plugin is for Claude Code users who want an easy way to start using Grok from the workflow
they already have. The command surface matches [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc): review, adversarial review, rescue, transfer, status, result, cancel, and an optional stop-time review gate.

## What You Get

- `/grok:review` for a normal read-only Grok review
- `/grok:adversarial-review` for a steerable challenge review
- `/grok:rescue`, `/grok:transfer`, `/grok:status`, `/grok:result`, and `/grok:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **A Grok account** signed in through the local Grok Build CLI (`grok login`).
- **Node.js 18.18 or later**
- The `grok` binary on `PATH`, or `GROK_BIN` pointing at it (Grok Build installs to `~/.grok/bin/grok`)

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add krushit/grok-plugin-cc
```

Install the plugin:

```bash
/plugin install grok@grok-plugin-cc
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/grok:setup
```

`/grok:setup` will tell you whether Grok is ready.

If Grok is installed but not logged in yet, run:

```bash
grok login
```

After install, you should see:

- the slash commands listed below
- the `grok:grok-rescue` subagent in `/agents`

One simple first run is:

```bash
/grok:review --background
/grok:status
/grok:result
```

## Usage

### `/grok:review`

Runs a normal Grok review on your current work.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/grok:adversarial-review`](#grokadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/grok:review
/grok:review --base main
/grok:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/grok:status`](#grokstatus) to check on the progress and [`/grok:cancel`](#grokcancel) to cancel the ongoing task.

### `/grok:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/grok:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/grok:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/grok:adversarial-review
/grok:adversarial-review --base main challenge whether this was the right caching and retry design
/grok:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/grok:rescue`

Hands a task to Grok through the `grok:grok-rescue` subagent.

Use it when you want Grok to:

- investigate a bug
- try a fix
- continue a previous Grok task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/grok:rescue investigate why the tests started failing
/grok:rescue fix the failing test with the smallest safe patch
/grok:rescue --resume apply the top fix from the last run
/grok:rescue --model grok-4.5 --effort medium investigate the flaky integration test
/grok:rescue --model spark fix the issue quickly
/grok:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Grok:

```text
Ask Grok to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Grok chooses its own defaults.
- if you say `spark`, the plugin maps that to `grok-4.5`
- follow-up rescue requests can continue the latest Grok task in the repo

### `/grok:transfer`

Creates a persistent Grok session from the current Claude Code session and prints a `grok --resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Grok.

Examples:

```bash
/grok:transfer
/grok:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer reads the Claude JSONL transcript, seeds a new Grok session with that history, and returns a session ID you can continue in the Grok TUI. The source must be under `~/.claude/projects`.

### `/grok:status`

Shows running and recent Grok jobs for the current repository.

Examples:

```bash
/grok:status
/grok:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/grok:result`

Shows the final stored Grok output for a finished job.
When available, it also includes the Grok session ID so you can reopen that run directly in Grok with `grok --resume <session-id>`.

Examples:

```bash
/grok:result
/grok:result task-abc123
```

### `/grok:cancel`

Cancels an active background Grok job.

Examples:

```bash
/grok:cancel
/grok:cancel task-abc123
```

### `/grok:setup`

Checks whether Grok is installed and authenticated.

You can also use `/grok:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Grok review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Grok loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/grok:review
```

### Hand A Problem To Grok

```bash
/grok:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/grok:adversarial-review --background
/grok:rescue --background investigate the flaky test
```

Then check in with:

```bash
/grok:status
/grok:result
```

## Grok Integration

The plugin wraps the local [Grok Build CLI](https://grok.com). It uses the `grok` binary installed on your machine and the same login state as the Grok TUI.

Delegated tasks and any [stop gate](#groksetup) run can also be resumed inside Grok:

```bash
grok --resume <session-id>
```

## FAQ

### Do I need a separate Grok account for this plugin?

If you are already signed into Grok Build on this machine, that account should work immediately here too. This plugin uses your local `grok` CLI authentication.

### Does the plugin use a separate Grok runtime?

No. This plugin delegates through your local Grok CLI on the same machine.

That means:

- it uses the same Grok install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment
