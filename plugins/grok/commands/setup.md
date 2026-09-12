---
description: Check whether the local Grok CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json $ARGUMENTS
```

If the result says Grok is unavailable:
- Tell the user to install Grok Build so `grok` is on PATH, or set `GROK_BIN`.
- Do not try to install Grok through npm.

Output rules:
- Present the final setup output to the user.
- If Grok is installed but not authenticated, preserve the guidance to run `grok login`.
