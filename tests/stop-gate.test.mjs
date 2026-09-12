import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildGitSnapshot, saveTurnBaseline } from "../plugins/grok/scripts/lib/git.mjs";
import { reasonIsThin } from "../plugins/grok/scripts/stop-review-gate-hook.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

/** A repo with one committed file, plus a place to keep the turn baseline. */
function scratchRepo() {
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "sub", "deep"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "app.js"), "let token = 'a';\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  return { cwd, stateDir: makeTempDir() };
}

test("a turn that edits an already-dirty file is detected from a subdirectory", () => {
  const { cwd, stateDir } = scratchRepo();
  const file = path.join(cwd, "app.js");
  // Dirty BEFORE the turn starts -- the ordinary mid-session case.
  fs.appendFileSync(file, "// edited by an earlier turn\n");

  // The hook runs with cwd wherever the session happens to be, not the root.
  const sub = path.join(cwd, "sub", "deep");
  saveTurnBaseline(sub, stateDir, "s1");
  fs.appendFileSync(file, "if (user) return true; // auth bypass\n");

  const snapshot = buildGitSnapshot(sub, stateDir, "s1");

  assert.equal(snapshot.evidenceOk, true);
  assert.match(snapshot.text, /app\.js/);
  assert.doesNotMatch(snapshot.text, /No working-tree or HEAD changes/);
});

test("staging a change is detected even when the working-tree bytes do not move", () => {
  const { cwd, stateDir } = scratchRepo();
  fs.appendFileSync(path.join(cwd, "app.js"), "// turn edit\n");
  saveTurnBaseline(cwd, stateDir, "s1");

  // Only the index changes here; the file on disk is byte-identical throughout.
  run("git", ["add", "app.js"], { cwd });

  assert.doesNotMatch(buildGitSnapshot(cwd, stateDir, "s1").text, /No working-tree or HEAD changes/);
});

test("a one-byte binary change is detected", () => {
  const { cwd, stateDir } = scratchRepo();
  const file = path.join(cwd, "blob.bin");
  fs.writeFileSync(file, Buffer.from([0x00, 0x80, 0xff]));
  saveTurnBaseline(cwd, stateDir, "s1");

  // 0x80 and 0x81 are both invalid UTF-8: decoding them collapses both onto
  // U+FFFD, which is exactly how this edit used to vanish.
  fs.writeFileSync(file, Buffer.from([0x00, 0x81, 0xff]));

  assert.doesNotMatch(buildGitSnapshot(cwd, stateDir, "s1").text, /No working-tree or HEAD changes/);
});

test("a missing baseline reports unknown scope rather than a clean tree", () => {
  const { cwd, stateDir } = scratchRepo();

  const snapshot = buildGitSnapshot(cwd, stateDir, "never-recorded");

  assert.equal(snapshot.evidenceOk, false);
  assert.match(snapshot.text, /UNKNOWN/);
});

test("a directory git cannot answer for reports unknown scope", () => {
  const outside = makeTempDir();

  const snapshot = buildGitSnapshot(outside, makeTempDir(), "s1");

  assert.equal(snapshot.evidenceOk, false);
  assert.doesNotMatch(snapshot.text, /clean/i);
});

test("the first commit in a fresh repo is not invisible", () => {
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const stateDir = makeTempDir();
  saveTurnBaseline(cwd, stateDir, "s1"); // unborn HEAD

  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('first');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "first"], { cwd });

  const snapshot = buildGitSnapshot(cwd, stateDir, "s1");

  assert.match(snapshot.text, /app\.js/);
  assert.doesNotMatch(snapshot.text, /No working-tree or HEAD changes/);
});

test("reasonIsThin catches the placeholder that started all this", () => {
  assert.equal(
    reasonIsThin("Placeholder while inspecting auth.mjs; this will be replaced after reading the actual diff."),
    true
  );
  assert.equal(reasonIsThin("ok"), true);
  assert.equal(reasonIsThin("I will now read the changed files and decide."), true);
});

test("reasonIsThin leaves a real finding alone", () => {
  assert.equal(
    reasonIsThin("Read auth.mjs; verifyToken compares only the first 8 characters, so any token sharing that prefix authenticates."),
    false
  );
  assert.equal(
    reasonIsThin("Reviewed the diff: Expo patch bumps and a types-only shared package; tsc and expo export both clean."),
    false
  );
});
