import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    // `status` is null when the child died on a signal (timeout kill, OOM).
    // Coercing that to 0 reported a killed process as a clean exit, so
    // runCommandChecked would not throw and callers read empty stdout as a
    // real answer. Keep it non-zero when a signal ended the process.
    status: result.status ?? (result.signal ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function which(command) {
  const result = runCommand(process.platform === "win32" ? "where" : "which", [command]);
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim().split(/\r?\n/, 1)[0] || null;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

/**
 * The command line of a running process, or "" if it cannot be read.
 *
 * Used to confirm a stored PID still belongs to the job that recorded it.
 * Process ids are recycled, and a job record outlives the process whenever
 * Claude Code exits without firing SessionEnd (a crash, a force quit), so a
 * stale `running` job can name a PID the OS has since handed to something else.
 */
export function readProcessCommandLine(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return "";
  }
  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  try {
    const result =
      platform === "win32"
        ? runCommandImpl("powershell", [
            "-NoProfile",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
          ])
        : runCommandImpl("ps", ["-p", String(pid), "-o", "args="]);
    if (result.error || result.status !== 0) {
      return "";
    }
    return String(result.stdout ?? "").trim();
  } catch {
    return "";
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  // Confirm the PID is still OUR process before signalling it. Without this a
  // recycled PID from a stale job record was signalled blind -- and on POSIX the
  // first signal goes to the process GROUP, so an unrelated terminal's whole job
  // tree could be taken down by a /grok:cancel or a SessionEnd.
  //
  //   marker found        -> signal normally
  //   marker absent       -> not ours; do nothing
  //   command unreadable  -> narrow to the single PID, never the group
  let identity = "unverified";
  if (options.expectMarker) {
    const commandLine =
      options.readCommandLineImpl?.(pid, { platform, runCommandImpl }) ??
      readProcessCommandLine(pid, { platform, runCommandImpl });
    if (!commandLine) {
      identity = "unverified";
    } else if (commandLine.includes(options.expectMarker)) {
      identity = "confirmed";
    } else {
      return { attempted: false, delivered: false, method: null, skipped: "pid-mismatch" };
    }
  }

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  let delivered = false;
  // Only signal the group when the process is confirmed ours, or when no marker
  // was requested at all (callers that genuinely own the pid).
  if (identity !== "unverified" || !options.expectMarker) {
    try {
      killImpl(-pid, "SIGTERM");
      delivered = true;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
  try {
    killImpl(pid, "SIGTERM");
    delivered = true;
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  return { attempted: true, delivered, method: "process-group-and-pid" };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
