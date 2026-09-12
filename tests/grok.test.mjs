import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { extractClaudeTranscript, parseStopDecision } from "../plugins/grok/scripts/lib/grok.mjs";

test("extractClaudeTranscript keeps user and assistant text and skips empty lines", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "session.jsonl");
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Fix the login bug." }] }
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect auth.ts." },
            { type: "tool_use", name: "Read", input: { path: "auth.ts" } }
          ]
        }
      }),
      JSON.stringify({ type: "progress", data: "ignored" })
    ].join("\n"),
    "utf8"
  );

  const transcript = extractClaudeTranscript(filePath);
  assert.match(transcript, /USER:\nFix the login bug\./);
  assert.match(transcript, /ASSISTANT:\nI will inspect auth\.ts\./);
  assert.doesNotMatch(transcript, /tool_use/);
});

test("parseStopDecision accepts structured ALLOW and BLOCK", () => {
  assert.equal(parseStopDecision({ structured: { decision: "ALLOW", reason: "clean" } }).ok, true);
  assert.equal(parseStopDecision({ structured: { decision: "BLOCK", reason: "bug" } }).ok, false);
  assert.equal(parseStopDecision({ text: "ALLOW: nothing to review" }).ok, true);
  assert.equal(parseStopDecision({ text: "BLOCK: missing test" }).ok, false);
});

// Regression: the stop gate blocked every turn because the decision arrived as
// a JSON string rather than a parsed `structured` object. The prompt asks for a
// bare JSON object, so this is the shape the gate actually sees; the old code
// ran the ALLOW:/BLOCK: prefix check against `{"decision":...` and reported
// "unexpected answer", blocking a turn Grok had allowed.
test("parseStopDecision reads a decision delivered as raw JSON text", () => {
  const allow = '{"decision":"ALLOW","reason":"no code edits"}';
  const block = '{"decision":"BLOCK","reason":"missing null check"}';

  assert.equal(parseStopDecision({ text: allow }).ok, true);
  assert.equal(parseStopDecision({ text: allow }).reason, "no code edits");
  assert.equal(parseStopDecision({ rawOutput: allow }).ok, true);

  assert.equal(parseStopDecision({ rawOutput: block }).ok, false);
  assert.equal(parseStopDecision({ rawOutput: block }).reason, "missing null check");
});

// Regression: Grok narrated before answering, so the output did not START with
// "{" and the gate blocked an ALLOW. This is the exact recorded rawOutput.
test("parseStopDecision finds the decision after narration", () => {
  const narrated =
    "I'll check whether the previous Claude turn actually changed code in this workspace before reviewing it." +
    '{"decision":"ALLOW","reason":"Previous turn made no code changes in this workspace."}';
  const result = parseStopDecision({ rawOutput: narrated });
  assert.equal(result.ok, true);
  assert.match(result.reason, /no code changes/);
});

test("parseStopDecision handles fences, trailing prose and braces inside reasons", () => {
  const fenced = '```json\n{"decision":"BLOCK","reason":"see {handler} at line 3"}\n```';
  const fencedResult = parseStopDecision({ text: fenced });
  assert.equal(fencedResult.ok, false);
  // A brace inside the reason string must not truncate the span.
  assert.equal(fencedResult.reason, "see {handler} at line 3");

  const trailing = '{"decision":"ALLOW","reason":"clean"}\nThat is my assessment.';
  assert.equal(parseStopDecision({ text: trailing }).ok, true);

  // Narration that itself contains an object: the real answer comes last.
  const twoObjects =
    'Considering {"decision":"BLOCK","reason":"first thought"} but on reflection ' +
    '{"decision":"ALLOW","reason":"final answer"}';
  const last = parseStopDecision({ text: twoObjects });
  assert.equal(last.ok, true);
  assert.equal(last.reason, "final answer");
});

test("parseStopDecision still rejects genuinely unparseable output", () => {
  assert.equal(parseStopDecision({ text: "I had a look and it seems fine" }).ok, false);
  // Looks like JSON, is not. Must not throw, must not silently allow.
  assert.equal(parseStopDecision({ text: '{"decision": ' }).ok, false);
  // Valid JSON, no decision field. Must not allow.
  assert.equal(parseStopDecision({ text: '{"verdict":"ALLOW"}' }).ok, false);
  // An unterminated object must not hang or allow.
  assert.equal(parseStopDecision({ text: 'thinking... {"decision":"ALLOW"' }).ok, false);
});
