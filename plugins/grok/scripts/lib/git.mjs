import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
// Beyond this a dirty file is fingerprinted by size+mtime rather than content.
const MAX_HASHED_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

function sha256(value) {
  // Buffers are hashed as bytes. Going through String() decodes them as UTF-8,
  // which maps every invalid byte onto U+FFFD -- so 0x80 and 0x81 produced the
  // same hash and a one-byte binary edit read as "no change".
  if (Buffer.isBuffer(value)) {
    return createHash("sha256").update(value).digest("hex");
  }
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

/**
 * Every path git reports is relative to the repository root, so every path we
 * join one onto must be the repository root too. Resolving it here rather than
 * trusting the caller's cwd is the whole fix for a class of silent passes: with
 * cwd set to a subdirectory, `path.join(cwd, rel)` pointed at nothing, every
 * hash came back "", and a turn that edited an already-dirty file compared
 * equal to its own baseline and was reported as "no changes".
 */
function repoRoot(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.status === 0) {
    const root = result.stdout.trim();
    if (root) {
      return root;
    }
  }
  return cwd;
}

function sessionKey(sessionId) {
  return String(sessionId || "default").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "default";
}

function baselinePath(stateDir, sessionId) {
  return path.join(stateDir, `turn-baseline-${sessionKey(sessionId)}.json`);
}

/**
 * Paths out of `git status --porcelain=v1 -z`.
 *
 * The -z form is used, and must be, because the human-readable form QUOTES any
 * path git considers special -- non-ASCII, spaces -- so `"r\303\251ponse.txt"`
 * arrived here quotes-and-all, matched nothing on disk, and hashed to "". The
 * baseline then saw "" before and after and concluded the file had not changed,
 * which is the gate quietly failing to notice an edit. A literal " -> " inside a
 * filename broke the rename heuristic the same way.
 *
 * In -z output each record is NUL-terminated and unquoted. A rename or copy
 * record carries the NEW path, and is followed by one extra NUL-separated token
 * holding the original path, which must be consumed rather than read as a record.
 */
function parsePorcelainZ(porcelain) {
  return parsePorcelainEntries(porcelain).map((entry) => entry.path);
}

/** Same walk, but keeping the XY status codes the fingerprint needs. */
function parsePorcelainEntries(porcelain) {
  const tokens = String(porcelain ?? "").split("\0");
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const rel = entry.slice(3).replace(/\/$/, "");
    if (rel) {
      entries.push({ path: rel, status });
    }
    // R/C records are followed by the original path; skip it.
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
      i += 1;
    }
  }
  return entries;
}

/**
 * Staged blob ids for the given paths, in one call.
 *
 * Without these the fingerprint saw only the working tree, so staging a change
 * -- or restaging different content while the working-tree bytes stayed put --
 * compared equal and the turn read as "no changes".
 */
function indexBlobs(root, paths) {
  const blobs = {};
  if (!paths.length) {
    return blobs;
  }
  const result = git(root, ["ls-files", "-s", "-z", "--", ...paths]);
  if (result.status !== 0) {
    return blobs;
  }
  for (const record of result.stdout.split("\0")) {
    if (!record) {
      continue;
    }
    const tab = record.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    // "<mode> <sha> <stage>\t<path>"
    blobs[record.slice(tab + 1)] = record.slice(0, tab);
  }
  return blobs;
}

function hashPath(cwd, rel) {
  const abs = path.join(cwd, rel);
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      return sha256(`symlink:${fs.readlinkSync(abs)}`);
    }
    if (st.isFile()) {
      // Reading the whole file is fine for source, ruinous for a large dirty
      // artifact: this runs on EVERY user prompt under a 15s hook timeout, and
      // a multi-gigabyte read would blow the timeout (or Node's buffer limit).
      // Above the cap, size+mtime is a weaker fingerprint but still detects the
      // edits this is here to notice.
      if (st.size > MAX_HASHED_FILE_BYTES) {
        return sha256(`meta:${st.size}:${st.mtimeMs}`);
      }
      return sha256(fs.readFileSync(abs));
    }
    if (st.isDirectory()) {
      // A submodule's entry name never changes when its contents do, so a
      // directory listing hashed an already-dirty submodule to the same value
      // before and after a turn edited code inside it. Ask the submodule.
      if (fs.existsSync(path.join(abs, ".git"))) {
        const head = git(abs, ["rev-parse", "HEAD"]);
        const status = git(abs, ["status", "--porcelain=v1", "-uall", "-z"]);
        return sha256(
          `submodule:${head.status === 0 ? head.stdout.trim() : "?"}:${
            status.status === 0 ? sha256(status.stdout) : "?"
          }`
        );
      }
      const names = fs.readdirSync(abs).sort().join("\n");
      return sha256(`dir:${names}`);
    }
  } catch {
    return "";
  }
  return "";
}

/**
 * Fingerprint every path git considers dirty.
 *
 * The fingerprint is three things, not one: the XY status code, the staged blob
 * id, and the working-tree content. Any of the three changing is a change. Using
 * working-tree bytes alone made staging-only edits invisible.
 */
function fileHashes(root, porcelain) {
  const entries = parsePorcelainEntries(porcelain);
  const blobs = indexBlobs(root, entries.map((entry) => entry.path));
  const hashes = {};
  for (const { path: rel, status } of entries) {
    hashes[rel] = `${status}:${blobs[rel] ?? "-"}:${hashPath(root, rel)}`;
  }
  return hashes;
}

function captureWorkingTree(cwd) {
  const root = repoRoot(cwd);
  const head = git(root, ["rev-parse", "HEAD"]);
  const porcelain = git(root, ["status", "--porcelain=v1", "-uall", "-z"]);
  // A failed status is not an empty status. Recording which it was lets the
  // snapshot refuse to describe missing evidence as a clean tree.
  const statusOk = porcelain.status === 0;
  const porcelainText = statusOk ? porcelain.stdout : "";
  return {
    root,
    head: head.status === 0 ? head.stdout.trim() : "",
    // An unborn HEAD is legitimately empty; a failed rev-parse is not.
    headOk: head.status === 0 || /unknown revision|ambiguous argument/i.test(head.stderr ?? ""),
    statusOk,
    porcelain: porcelainText,
    files: statusOk ? fileHashes(root, porcelainText) : {},
    capturedAt: new Date().toISOString()
  };
}

export function saveTurnBaseline(cwd, stateDir, sessionId) {
  if (!stateDir) {
    return;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    baselinePath(stateDir, sessionId),
    `${JSON.stringify(captureWorkingTree(cwd), null, 2)}\n`,
    "utf8"
  );
}

/**
 * Describe what this turn changed, and say plainly when it cannot.
 *
 * Returns { text, evidenceOk }. `evidenceOk` is false when the snapshot could
 * not establish the turn's scope at all -- no baseline, or git itself failed.
 * That is different from "the turn changed nothing", and the caller must treat
 * it differently: reporting missing evidence as a clean tree is what let real
 * changes through with an explicit "No working-tree or HEAD changes" message.
 */
export function buildGitSnapshot(cwd, stateDir, sessionId) {
  const now = captureWorkingTree(cwd);
  const root = now.root;
  const file = stateDir ? baselinePath(stateDir, sessionId) : null;
  let baseline = null;
  if (file && fs.existsSync(file)) {
    try {
      baseline = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      baseline = null;
    }
  }

  const lines = ["Turn-scoped repository snapshot:"];

  if (!now.statusOk || !now.headOk) {
    lines.push(
      "git could not be queried for this workspace, so the turn's changes are UNKNOWN.",
      "This is not evidence that nothing changed."
    );
    return { text: lines.join("\n"), evidenceOk: false };
  }

  if (!baseline) {
    lines.push(
      "No turn baseline was recorded, so the turn's scope is UNKNOWN.",
      "The dirty tree below is the whole working tree, not this turn's changes,",
      "and it cannot show anything the turn already committed."
    );
    const status = git(root, ["status", "--short", "--untracked-files=all"]);
    const statusText = status.status === 0 ? status.stdout.trim() : "";
    if (statusText) {
      lines.push("git status --short:", statusText);
    } else {
      lines.push("The working tree is currently clean.");
    }
    return { text: lines.join("\n"), evidenceOk: false };
  }

  lines.push(`Baseline captured at ${baseline.capturedAt || "unknown"} (HEAD ${baseline.head || "?"}).`);
  if (baseline.statusOk === false) {
    lines.push(
      "The baseline itself recorded a git failure, so comparison is UNKNOWN."
    );
    return { text: lines.join("\n"), evidenceOk: false };
  }

  const beforeFiles = baseline.files && typeof baseline.files === "object" ? baseline.files : {};
  const afterFiles = now.files || {};
  const names = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
  const changed = [...names].filter((rel) => beforeFiles[rel] !== afterFiles[rel]).sort();
  let committedFiles = "";
  if (now.head && now.head !== baseline.head) {
    // An unborn baseline HEAD is the empty string: the turn's first commit has
    // no `before` to diff against, so list the commit's own contents instead.
    const range = baseline.head ? `${baseline.head}..${now.head}` : now.head;
    const committed = git(root, baseline.head
      ? ["diff", "--name-only", range]
      : ["show", "--name-only", "--format=", now.head]);
    committedFiles = committed.status === 0 ? committed.stdout.trim() : "";
    lines.push(`HEAD moved ${baseline.head ? baseline.head.slice(0, 7) : "(unborn)"} -> ${now.head.slice(0, 7)}.`);
    if (committedFiles) {
      lines.push("Files in commits since turn start:", committedFiles);
    }
  }
  if (changed.length === 0 && !committedFiles) {
    lines.push("No working-tree or HEAD changes since the start of this turn.");
    return { text: lines.join("\n"), evidenceOk: true };
  }
  if (changed.length) {
    lines.push("Paths whose contents changed since turn start (includes untracked files):", changed.join("\n"));
    // Paths from git are root-relative, so they must be tested and passed
    // relative to the root -- not to whatever cwd the hook happened to run in.
    const tracked = changed.filter((rel) => fs.existsSync(path.join(root, rel)));
    if (tracked.length) {
      const stat = git(root, ["diff", "--stat", "HEAD", "--", ...tracked]);
      if (stat.status === 0 && stat.stdout.trim()) {
        lines.push(stat.stdout.trim());
      }
    }
  }
  return { text: lines.join("\n"), evidenceOk: true };
}

export function formatGitSnapshot(cwd, stateDir, sessionId) {
  return buildGitSnapshot(cwd, stateDir, sessionId).text;
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
