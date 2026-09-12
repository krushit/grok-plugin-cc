# Changelog

## 4.0.0

A Grok companion for Claude Code, whose main feature is a **stop-time review
gate**: when Claude Code finishes a turn, Grok reviews what that turn actually
changed and either allows the turn to end or blocks it with the defects it
found, forcing a fix before work stops.

Getting that gate to genuinely review took several passes, and the lessons are
worth stating because each one produced a gate that looked like it was working
while it was not.

**It has to actually read the code before it answers.** Given a JSON schema,
Grok emits the decision object as its first act and treats it as a plan it can
revise later — it cannot, because that emission ends the turn. So every verdict
was pre-review narration, and a deliberately planted auth bypass sailed through
with the reason "Placeholder while inspecting … this will be replaced after
reading the actual diff." Prompt wording alone did not fix it. The review now
runs in two passes: an unconstrained one that opens the files and writes
findings, then a schema-constrained one that resumes that same thread and states
a verdict. The schema lands on a conclusion instead of an opening move.

**It has to look in the right place.** Git reports paths relative to the
repository root; the change-detection fingerprint joined them onto the hook's
working directory. With the session anywhere below the root — the ordinary case
— every file test failed, every hash came back empty, and a turn that edited an
already-dirty file compared equal to its own baseline. The gate then announced
"No working-tree or HEAD changes since the start of this turn" and allowed it.

**Absence of evidence is not evidence of absence.** A failed `git status`, a
missing turn baseline, an unborn HEAD, a hook killed by its own timeout, a throw
outside the review's `try`, an unparseable state file — each one ended a turn
quietly, and several of them looked identical to a clean pass. They now say so
and block, because a turn that could not be reviewed has not been cleared. The
fingerprint also covers the index and the status code rather than working-tree
bytes alone, hashes buffers as bytes so a one-byte binary change cannot collapse
onto the same value, and asks submodules about themselves.

**It has to read the rules it is enforcing.** The gate reads the `CLAUDE.md` and
`AGENTS.md` governing each changed path and checks the change against what they
actually say, quoting the rule it applies. Before this it would flag a bucket for
having no encryption and then miss the identical rule in a shell script two
rounds earlier, because nothing had ever told it the rule existed. Inventing
rules those files do not state is explicitly out of bounds.

**Asking for brevity suppressed findings.** The prompt, the schema description
and the verdict pass all asked for "one or two sentences", and rounds containing
four real defects came back naming two. A block now lists every defect it found,
one clause each, because someone will fix exactly what is named and then stop.
Allow stays short.

Also here: verdicts are recorded to disk with their reasoning, so a silently
disabled gate no longer looks the same as a passing one; a blocked turn is
re-reviewed rather than waved through on the next stop, bounded by a three-block
cap so a disagreement cannot trap a session; a verdict whose justification is
filler or a promise of future work is treated as an unreviewed turn; and the
investigation cannot be overruled by the verdict pass that follows it.

Verified against planted defects across eight rounds in eight areas — Python,
React, Bash, Terraform, a DynamoDB Lambda, an Expo screen, a GitHub Actions
workflow, and an OAuth broker. Every round was blocked. Each fix in the gate
itself carries a test, and each was checked by reverting the fix and confirming
the matching test — and only that test — failed.
