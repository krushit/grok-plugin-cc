---
name: grok-prompting
description: Internal guidance for tightening a rescue request before forwarding it to Grok
user-invocable: false
---

# Grok prompting

Use this skill only to rewrite the user's rescue request into a tighter prompt for `grok-companion.mjs task`.

Rules:
- Keep the user's intent, constraints, and file names.
- Make the request concrete: what to inspect, what good looks like, and when to stop.
- Do not inspect the repository.
- Do not draft a solution.
- Do not add work the user did not ask for.
- Return only the rewritten prompt text.
