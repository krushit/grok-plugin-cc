import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand, which } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
export const TASK_THREAD_PREFIX = "Grok Companion Task";

const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const REVIEW_TOOLS_DENY = ["search_replace", "web_search", "web_fetch", "Agent"].join(",");
const MAX_TRANSFER_CHARS = 40_000;

export function resolveGrokBinary() {
  if (process.env.GROK_BIN) {
    return process.env.GROK_BIN;
  }
  const homeBin = path.join(GROK_HOME, "bin", "grok");
  if (fs.existsSync(homeBin)) {
    return homeBin;
  }
  return which("grok");
}

export function getGrokAvailability(cwd) {
  const binary = resolveGrokBinary();
  if (!binary) {
    return {
      available: false,
      binary: null,
      detail: "grok CLI not found. Install Grok Build, or set GROK_BIN."
    };
  }
  const version = binaryAvailable(binary, ["--version"], { cwd });
  if (!version.available) {
    return {
      available: false,
      binary,
      detail: `grok found at ${binary} but --version failed: ${version.detail}`
    };
  }
  return {
    available: true,
    binary,
    detail: version.detail
  };
}

export function getCodexAvailability(cwd) {
  return getGrokAvailability(cwd);
}

function hasUsableSecret(value, depth = 0) {
  if (depth > 6 || value == null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length >= 12;
  }
  if (typeof value === "object") {
    return Object.values(value).some((entry) => hasUsableSecret(entry, depth + 1));
  }
  return false;
}

export function getGrokAuthStatus() {
  const authFile = path.join(GROK_HOME, "auth.json");
  if (!fs.existsSync(authFile)) {
    return { loggedIn: false, detail: "not signed in (no ~/.grok/auth.json). Run `grok login`." };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile, "utf8"));
    if (!hasUsableSecret(parsed)) {
      return { loggedIn: false, detail: "auth.json has no usable credentials. Run `grok login`." };
    }
    return { loggedIn: true, detail: "signed in" };
  } catch {
    return { loggedIn: false, detail: "auth.json is unreadable. Run `grok login`." };
  }
}

export async function getCodexAuthStatus() {
  const auth = getGrokAuthStatus();
  return {
    available: true,
    loggedIn: auth.loggedIn,
    requiresOpenaiAuth: !auth.loggedIn,
    detail: auth.detail
  };
}

export function getSessionRuntimeStatus() {
  const availability = getGrokAvailability(process.cwd());
  if (!availability.available) {
    return {
      mode: "unavailable",
      label: "Grok CLI unavailable",
      detail: availability.detail,
      endpoint: null
    };
  }
  return {
    mode: "direct",
    label: "Grok CLI",
    detail: availability.detail,
    endpoint: null
  };
}

export function buildPersistentTaskThreadName(prompt) {
  const compact = String(prompt ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return compact ? `${TASK_THREAD_PREFIX}: ${compact}` : TASK_THREAD_PREFIX;
}

export function findLatestTaskThread() {
  return null;
}

function writeTempFile(prefix, contents) {
  const filePath = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function removeFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
}

function minifyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

function emitProgress(onProgress, message, phase, extra = {}) {
  if (!onProgress) {
    return;
  }
  onProgress({
    message,
    phase,
    ...extra
  });
}

function parseGrokStdout(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return { structured: null, text: "", sessionId: null, payload: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { structured: null, text, sessionId: null, payload: null };
  }

  if (parsed && typeof parsed === "object" && parsed.type === "error") {
    throw new Error(parsed.message || "Grok returned an error object.");
  }

  const structured =
    parsed?.structured_output && typeof parsed.structured_output === "object"
      ? parsed.structured_output
      : null;
  const body = String(parsed?.text ?? "").trim();
  const sessionId = parsed?.sessionId ?? parsed?.session_id ?? null;

  if (structured) {
    return { structured, text: body || JSON.stringify(structured), sessionId, payload: parsed };
  }

  if (body) {
    try {
      return { structured: JSON.parse(body), text: body, sessionId, payload: parsed };
    } catch {
      return { structured: null, text: body, sessionId, payload: parsed };
    }
  }

  if (parsed && typeof parsed === "object" && (parsed.decision || parsed.verdict)) {
    return { structured: parsed, text, sessionId, payload: parsed };
  }

  return { structured: null, text: body || text, sessionId, payload: parsed };
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

/** JSON.parse, but only accept an object that actually carries a decision. */
function tryParseDecision(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && typeof parsed.decision === "string") {
      return parsed;
    }
  } catch {
    // Not a decision object.
  }
  return null;
}

/**
 * Read the balanced {...} span starting at `start`, or null if it never closes.
 * String literals are skipped so a brace inside a reason cannot end the span.
 */
function readBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Find the decision object anywhere in the output, tolerating narration and code fences. */
function extractDecisionObject(text) {
  if (!text) {
    return null;
  }
  const whole = tryParseDecision(text);
  if (whole) {
    return whole;
  }
  let found = null;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") {
      continue;
    }
    const span = readBalancedObject(text, i);
    if (!span) {
      continue;
    }
    const parsed = tryParseDecision(span);
    if (parsed) {
      found = parsed;
      i += span.length - 1;
    }
  }
  return found;
}

export function parseStopDecision(result) {
  const structured = result.structured;
  if (structured && typeof structured.decision === "string") {
    const decision = structured.decision.trim().toUpperCase();
    const reason = String(structured.reason ?? "").trim();
    if (decision === "ALLOW") {
      return { ok: true, reason: reason || "Grok allowed the turn." };
    }
    if (decision === "BLOCK") {
      return { ok: false, reason: reason || "Grok blocked the turn." };
    }
  }

  const text = String(result.text ?? result.rawOutput ?? "").trim();

  // The prompt asks for a bare JSON object, but a model that narrates before it
  // answers still produces a usable decision:
  //
  //   I'll check whether the previous turn changed code...{"decision":"ALLOW",...}
  //
  // Requiring the text to *be* the object missed that and blocked a turn Grok had
  // allowed, so find the object rather than demanding it stand alone. The LAST
  // decision object wins: narration comes first, the answer comes last.
  const decision = extractDecisionObject(text);
  if (decision) {
    return parseStopDecision({ structured: decision });
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: firstLine.slice("ALLOW:".length).trim() || "Grok allowed the turn." };
  }
  if (firstLine.startsWith("BLOCK:")) {
    return {
      ok: false,
      reason: firstLine.slice("BLOCK:".length).trim() || "Grok blocked the turn."
    };
  }

  return {
    ok: false,
    reason: "Grok stop-time review returned an unexpected answer. Run /grok:review or bypass the gate."
  };
}

export function runGrokHeadless({
  cwd,
  prompt,
  schemaJson,
  model,
  effort,
  write = false,
  sandbox,
  resumeThreadId = null,
  maxTurns = 25,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onProgress = null
}) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(availability.detail);
  }

  const promptFile = writeTempFile("grok-companion-prompt", prompt);
  const effectiveSandbox = sandbox ?? (write ? "workspace" : "read-only");
  const args = [
    "--prompt-file",
    promptFile,
    "--output-format",
    "json",
    "--sandbox",
    effectiveSandbox,
    "--always-approve",
    "--max-turns",
    String(maxTurns),
    "--verbatim",
    "--cwd",
    cwd
  ];

  if (!write) {
    args.push("--disallowed-tools", REVIEW_TOOLS_DENY);
  }
  if (schemaJson) {
    args.push(
      "--json-schema",
      typeof schemaJson === "string" ? minifyJson(schemaJson) : JSON.stringify(schemaJson)
    );
  }
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (resumeThreadId) {
    args.push("--resume", resumeThreadId);
  }

  emitProgress(onProgress, resumeThreadId ? `Resuming Grok session ${resumeThreadId}.` : "Starting Grok.", "starting", {
    threadId: resumeThreadId ?? null
  });

  try {
    const result = runCommand(availability.binary, args, {
      cwd,
      timeout: timeoutMs,
      shell: false,
      env: {
        ...process.env,
        GROK_AGENT_DASHBOARD: "0"
      }
    });

    if (result.error?.code === "ETIMEDOUT") {
      throw new Error(`Grok timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    if (result.error) {
      throw new Error(result.error.message);
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      throw new Error(detail || `Grok exited ${result.status}`);
    }

    const parsed = parseGrokStdout(result.stdout);
    emitProgress(onProgress, "Grok finished.", "done", { threadId: parsed.sessionId });
    return {
      ...parsed,
      stderr: result.stderr,
      status: result.status
    };
  } finally {
    removeFile(promptFile);
  }
}

export async function runAppServerTurn(cwd, options = {}) {
  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Grok run.");
  }

  const schemaJson = options.outputSchema ? JSON.stringify(options.outputSchema) : null;
  const write = options.sandbox === "workspace-write" || options.sandbox === "workspace";
  const result = runGrokHeadless({
    cwd,
    prompt,
    schemaJson,
    model: options.model,
    effort: options.effort,
    write,
    sandbox: write ? "workspace" : "read-only",
    resumeThreadId: options.resumeThreadId ?? null,
    maxTurns: options.maxTurns ?? (write ? 40 : 25),
    onProgress: options.onProgress
  });

  const rawOutput =
    result.structured && options.outputSchema ? JSON.stringify(result.structured) : result.text;

  return {
    status: result.status ?? 0,
    threadId: result.sessionId,
    turnId: result.payload?.requestId ?? null,
    finalMessage: rawOutput,
    reviewText: rawOutput,
    stderr: result.stderr ?? "",
    error: null,
    reasoningSummary: [],
    touchedFiles: []
  };
}

export async function runAppServerReview(cwd, options = {}) {
  const target = options.target ?? { type: "uncommittedChanges" };
  const prompt =
    target.type === "baseBranch"
      ? `Review the git diff of the current branch against ${target.branch}. Stay review-only. Do not edit files.`
      : "Review the current uncommitted working tree (staged, unstaged, and untracked). Stay review-only. Do not edit files.";

  const result = await runAppServerTurn(cwd, {
    prompt,
    model: options.model,
    sandbox: "read-only",
    onProgress: options.onProgress,
    maxTurns: 40
  });

  return {
    status: result.status,
    threadId: result.threadId,
    sourceThreadId: null,
    turnId: result.turnId,
    reviewText: result.finalMessage,
    stderr: result.stderr,
    reasoningSummary: result.reasoningSummary
  };
}

/**
 * Ask a running Grok turn to stop cooperatively.
 *
 * NOT IMPLEMENTED, deliberately and visibly. Grok is driven here as a headless
 * CLI process, not over an app-server session, so there is no channel on which
 * to deliver an interrupt. Cancellation therefore works by terminating the
 * worker process (see terminateProcessTree), which is what /grok:cancel relies
 * on; this hook exists so a cooperative interrupt can be slotted in later
 * without reshaping the cancel path.
 *
 * It reports `attempted: false` rather than throwing, and the caller only logs
 * when something was attempted, so a cancel produces no misleading "interrupt
 * failed" line. Return `attempted: true` once there is a real channel.
 */
export async function interruptAppServerTurn() {
  return { attempted: false, interrupted: false, detail: null };
}

function extractTextBlocks(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      if (typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function extractClaudeTranscript(sourcePath, maxChars = MAX_TRANSFER_CHARS) {
  const raw = fs.readFileSync(sourcePath, "utf8");
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const type = parsed.type || parsed.role;
    const message = parsed.message ?? parsed;
    const role = message.role || (type === "assistant" ? "assistant" : type === "user" ? "user" : null);
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractTextBlocks(message.content);
    if (!text) {
      continue;
    }
    lines.push(`${role.toUpperCase()}:\n${text}`);
  }

  let transcript = lines.join("\n\n");
  if (transcript.length > maxChars) {
    transcript = `${transcript.slice(-maxChars)}\n\n[truncated]`;
  }
  return transcript;
}

export async function importExternalAgentSession(cwd, options = {}) {
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }
  const transcript = extractClaudeTranscript(options.sourcePath);
  if (!transcript.trim()) {
    throw new Error(`No user/assistant text was found in ${options.sourcePath}.`);
  }

  const prompt = [
    "The following is a Claude Code session transferred into Grok so you can continue the work.",
    "After reading it, reply with a short recap of the current state and wait for the next instruction.",
    "Do not start implementing unless the transcript itself ends on an unanswered user request.",
    "",
    "<transcript>",
    transcript,
    "</transcript>"
  ].join("\n");

  const result = runGrokHeadless({
    cwd,
    prompt,
    write: true,
    sandbox: "workspace",
    maxTurns: 8,
    onProgress: options.onProgress
  });

  if (!result.sessionId) {
    throw new Error("Grok imported the Claude session but did not return a session ID.");
  }

  return {
    threadId: result.sessionId,
    stderr: result.stderr ?? ""
  };
}
