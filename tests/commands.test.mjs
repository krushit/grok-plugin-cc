import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../plugins/grok/scripts/lib/args.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Grok's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(
    source,
    /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/grok-companion\.mjs" review "\$ARGUMENTS"`/
  );
  assert.match(source, /description:\s*"Grok review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Grok's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(
    source,
    /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/grok-companion\.mjs" adversarial-review "\$ARGUMENTS"`/
  );
  assert.match(source, /description:\s*"Grok adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/grok:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/grok-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/grok-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Grok's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  assert.match(rescue, /subagent_type: "grok:grok-rescue"/);
  assert.match(rescue, /do not call `Skill\(grok:grok-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model\|spark>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Grok session/);
  assert.match(rescue, /Start a new Grok session/);
  assert.match(rescue, /run the `grok:grok-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort/i);
  assert.match(rescue, /If they ask for `spark`, map it to `grok-4\.5`/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Grok companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(
    agent,
    /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Grok running for a long time, prefer background execution/i
  );
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(
    agent,
    /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i
  );
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific reasoning effort/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `spark`, map that to `--model grok-4\.5`/i);
  assert.match(agent, /If the user asks for a concrete model name such as `grok-4\.6`, pass it through with `--model`/i);
  assert.match(agent, /Return the stdout of the `grok-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Grok cannot be invoked, return nothing/i);
  assert.match(agent, /grok-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Grok prompt/i);
  assert.match(
    agent,
    /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i
  );
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `grok-prompting` skill to rewrite the user's request into a tighter Grok prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave `--effort` unset unless the user explicitly requests a specific effort/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Map `spark` to `--model grok-4\.5`/i);
  assert.match(
    runtimeSkill,
    /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i
  );
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`/i);
  assert.match(
    runtimeSkill,
    /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i
  );
  assert.match(runtimeSkill, /If the Bash call fails or Grok cannot be invoked, return nothing/i);
  assert.match(readme, /`grok:grok-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model` or `--effort`, Grok chooses its own defaults/i);
  assert.match(readme, /--model grok-4\.5 --effort medium/i);
  assert.match(readme, /`spark`, the plugin maps that to `grok-4\.5`/i);
  assert.match(readme, /continue a previous Grok task/i);
  assert.match(readme, /### `\/grok:setup`/);
  assert.match(readme, /### `\/grok:review`/);
  assert.match(readme, /### `\/grok:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/grok:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/grok:rescue`/);
  assert.match(readme, /### `\/grok:transfer`/);
  assert.match(readme, /### `\/grok:status`/);
  assert.match(readme, /### `\/grok:result`/);
  assert.match(readme, /### `\/grok:cancel`/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/grok-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /grok-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /grok --resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /grok-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /grok-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Grok run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Grok was never successfully invoked, do not generate a substitute answer at all/i);
});

// Regression: split("=", 2) discards everything past the second field instead of
// keeping it, so an inline value containing "=" was silently truncated.
test("parseArgs keeps '=' inside an inline option value", () => {
  const parsed = parseArgs(["--cwd=/tmp/a=b/project"], { valueOptions: ["cwd"] });
  assert.equal(parsed.options.cwd, "/tmp/a=b/project");

  const schema = parseArgs(['--json-schema={"const":"a=b"}'], { valueOptions: ["json-schema"] });
  assert.equal(schema.options["json-schema"], '{"const":"a=b"}');

  // The other forms must be unaffected.
  assert.equal(parseArgs(["--wait"], { booleanOptions: ["wait"] }).options.wait, true);
  assert.equal(parseArgs(["--wait=false"], { booleanOptions: ["wait"] }).options.wait, false);
  assert.equal(parseArgs(["--model", "grok-4"], { valueOptions: ["model"] }).options.model, "grok-4");
});
