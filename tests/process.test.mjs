import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/grok/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

// Regression: a job record outlives its process whenever Claude Code exits without
// firing SessionEnd (crash, force quit), and PIDs get recycled. Signalling a stale
// pid blind killed whatever now held it -- and on POSIX the first signal goes to
// the process GROUP, so an unrelated terminal's whole tree could go down.
test("terminateProcessTree refuses a pid that is not the job's process", () => {
  const killed = [];
  const result = terminateProcessTree(4242, {
    platform: "linux",
    expectMarker: "job-abc",
    readCommandLineImpl: () => "node /usr/bin/something-else --unrelated",
    killImpl: (pid, signal) => killed.push([pid, signal])
  });

  assert.equal(result.attempted, false);
  assert.equal(result.skipped, "pid-mismatch");
  assert.deepEqual(killed, [], "must not signal a process that is not ours");
});

test("terminateProcessTree signals group and pid when identity is confirmed", () => {
  const killed = [];
  const result = terminateProcessTree(4242, {
    platform: "linux",
    expectMarker: "job-abc",
    readCommandLineImpl: () => "node grok-companion.mjs task-worker --job-id job-abc",
    killImpl: (pid, signal) => killed.push([pid, signal])
  });

  assert.equal(result.delivered, true);
  assert.deepEqual(killed, [[-4242, "SIGTERM"], [4242, "SIGTERM"]]);
});

// When the command line cannot be read we still clean up, but we narrow the blast
// radius to the single pid rather than taking down a whole process group.
test("terminateProcessTree narrows to the pid when identity cannot be read", () => {
  const killed = [];
  terminateProcessTree(4242, {
    platform: "linux",
    expectMarker: "job-abc",
    readCommandLineImpl: () => "",
    killImpl: (pid, signal) => killed.push([pid, signal])
  });

  assert.deepEqual(killed, [[4242, "SIGTERM"]], "group must not be signalled unverified");
});
