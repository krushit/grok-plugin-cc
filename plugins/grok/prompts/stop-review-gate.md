<task>
Run a stop-gate review of the previous Claude turn.
Only review the work from the previous Claude turn.
Only review it if Claude actually did code changes in that turn.
Pure status, setup, or reporting output does not count as reviewable work.
For example, the output of /grok:setup or /grok:review does not count.
Only direct edits made in that specific turn count.
If the previous Claude turn was only a status update, a summary, a setup/login check, a review result, or output from a command that did not itself make direct edits in that turn, return ALLOW immediately and do no further work.
Challenge whether that specific work and its design choices should ship.

{{CLAUDE_RESPONSE_BLOCK}}

{{GIT_SNAPSHOT_BLOCK}}
</task>

<investigate_before_answering>
The JSON object is your CONCLUSION, not your plan. Emitting it ends the review,
so anything you have not read by then is unreviewed.

Before you emit it you must actually open the changed files. The snapshot names
them; it does not contain their contents. Read the diff or the files themselves.

`reason` is therefore written in the PAST TENSE and states what you found:
"Read auth.mjs; verifyToken compares only the first 8 characters, so any token
sharing that prefix authenticates." Never the future tense. If your reason
contains "I will", "before deciding", "then I will check", or any other promise
of work still to come, you have answered too early and the verdict is void.
</investigate_before_answering>

<compact_output_contract>
Return a compact final answer that matches the JSON schema.
decision must be exactly ALLOW or BLOCK.
Do not put any text outside the JSON object.

reason is read by a human deciding whether to trust this verdict, so it must say
what you actually examined. Keep an ALLOW to one or two sentences.

A BLOCK must list EVERY defect you found, not just the first or the worst -- one
short clause each, separated by semicolons. A reviewer who fixes the one defect
you named and stops has not fixed the file. Length is not a virtue here, but
completeness is: four real defects means four clauses.

- ALLOW because nothing changed: say what you checked to establish that, e.g.
  "Working tree clean and HEAD unmoved since the turn baseline; the turn only
  printed status."
- ALLOW after reviewing changes: name the files or behaviour you looked at, e.g.
  "Reviewed the three changed files in packages/auth; the token prefix stays
  pinned, so existing connections keep working."
- BLOCK: name the specific defect and where it is, e.g. "parseAmount() drops the
  sign on negatives, so the Day change KPI reads positive on a loss."

Do NOT return a placeholder, a restatement of the decision, or a bare "looks
fine". "Grok allowed the turn", "placeholder", "no issues" and similar are not
acceptable reasons.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW if the previous turn did not make code changes or if you do not see a blocking issue.
Use ALLOW immediately, without extra investigation, if the previous turn was not an edit-producing turn.
Use ALLOW immediately if the git snapshot shows a clean working tree and there is no evidence of a commit from that turn.
Use BLOCK only if the previous turn made code changes and you found something that still needs to be fixed before stopping.
</default_follow_through_policy>

<grounding_rules>
Ground every blocking claim in the repository context or tool outputs you inspected during this run.
Do not treat the previous Claude response as proof that code changes happened; verify that from the repository snapshot before you block.
If the turn-scoped snapshot reports no working-tree or HEAD changes since turn start, ALLOW immediately.
Only BLOCK on issues in files listed as changed since the turn baseline.
Do not treat dirty files that were already dirty at turn start as this-turn work.
Do not block based on older edits from earlier turns when the immediately previous turn did not itself make direct edits.
Do not block on nits, style preferences, or missing follow-up work that the user did not ask for.
</grounding_rules>

<project_conventions>
This repository states its own rules, and a change that breaks one is a defect
even when the code is otherwise correct. You will not infer these rules from the
diff -- you have to read them.

Before deciding, read the context files governing the changed paths: any
CLAUDE.md or AGENTS.md at the repository root, and the nearest one in or above
each changed file's directory. They are usually short and they hierarchically
override each other, most specific winning.

Check the change against what they actually say. Treat a stated requirement as
binding: a mandated region or placement, a required encryption or access
setting, a pinned version or dependency rule, a naming or layout convention, a
documented invariant about how something is built or deployed. Quote the rule
you are applying so the verdict can be checked.

Do not invent rules these files do not state, and do not block on a convention
you merely infer from surrounding code unless the change is inconsistent in a
way that will actually break something.
</project_conventions>

<sweep_before_deciding>
Once you have read the changed files, sweep them deliberately for these classes
rather than stopping at the first defect you notice. Each has been missed by
this gate before:

- Concurrency and ordering: unawaited or unabortable async work, responses that
  can resolve out of order and overwrite newer state, work that continues after
  its caller is gone, missing cleanup for anything subscribed or scheduled.
- Error propagation: a script without `set -euo pipefail` or equivalent, so a
  failed step continues and a broken artifact ships; ignored exit codes; a catch
  that swallows.
- Unset and empty inputs: an unquoted or unvalidated variable that expands to
  nothing, an empty collection reaching a division or an index, a null that the
  happy path never sees.
- Secrets, encryption and access: anything public that should not be, anything
  stored or transmitted unencrypted, credentials or personal data in a log, a
  permission wider than the task needs.
- Placement and lifecycle: resources created in the wrong region or account,
  identifiers that are immutable once applied, changes that silently replace
  live infrastructure.
- Deprecated or wrong-for-this-repo APIs, where a current equivalent is already
  used elsewhere in the codebase.

This is a checklist for reading, not a template for the answer. Report only what
you actually found.
</sweep_before_deciding>

<dig_deeper_nudge>
If the previous turn did make code changes, check for second-order failures, empty-state behavior, retries, stale state, rollback risk, and design tradeoffs before you finalize.
Prefer reading the files named in the git snapshot over guessing from the Claude response.
</dig_deeper_nudge>
