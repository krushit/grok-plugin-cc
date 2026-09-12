import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "grok-companion");
const STABLE_STATE_ROOT = path.join(os.homedir(), ".claude", "plugins", "data", "grok-grok-plugin-cc", "state");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

function workspaceKey(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function resolveStateDir(cwd) {
  const key = workspaceKey(cwd);
  const dest = path.join(STABLE_STATE_ROOT, key);
  const destFile = path.join(dest, STATE_FILE_NAME);
  if (!fs.existsSync(destFile)) {
    const pluginDataDir = process.env[PLUGIN_DATA_ENV];
    const candidates = [];
    if (pluginDataDir) {
      candidates.push(path.join(pluginDataDir, "state", key));
    }
    candidates.push(path.join(FALLBACK_STATE_ROOT_DIR, key));
    for (const oldDir of candidates) {
      const oldFile = path.join(oldDir, STATE_FILE_NAME);
      if (oldFile === destFile || !fs.existsSync(oldFile)) {
        continue;
      }
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(oldFile, destFile);
      const oldJobs = path.join(oldDir, JOBS_DIR_NAME);
      const destJobs = path.join(dest, JOBS_DIR_NAME);
      if (fs.existsSync(oldJobs) && !fs.existsSync(destJobs)) {
        fs.cpSync(oldJobs, destJobs, { recursive: true });
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(destFile, "utf8"));
        if (Array.isArray(parsed.jobs)) {
          for (const job of parsed.jobs) {
            if (job?.logFile) {
              job.logFile = path.join(destJobs, path.basename(job.logFile));
            }
          }
          fs.writeFileSync(destFile, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
        }
      } catch {
        // keep copied file as-is if rewrite fails
      }
      break;
    }
  }
  return dest;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}



function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withStateLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "state.lock");
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error.code === "EEXIST") {
        try {
          const owner = Number(fs.readFileSync(lock, "utf8").trim());
          if (owner && !pidAlive(owner)) {
            fs.unlinkSync(lock);
            continue;
          }
        } catch {
          // retry until deadline
        }
      }
      if (error.code !== "EEXIST" || Date.now() > deadline) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // ignore
    }
  }
}

function loadStateUnlocked(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    // A state file that EXISTS but will not parse is not the same as no state
    // file. Falling back to defaults here silently answered stopReviewGate
    // false -- a corrupt state file turned the review gate off without a word.
    // Flag it and let callers that care fail closed.
    const fallback = defaultState();
    fallback.unreadable = true;
    return fallback;
  }
}

export function loadState(cwd) {
  return withStateLock(resolveStateDir(cwd), () => loadStateUnlocked(cwd));
}

export function saveState(cwd, state) {
  const dir = resolveStateDir(cwd);
  return withStateLock(dir, () => {
    const previousJobs = loadStateUnlocked(cwd).jobs;
    ensureStateDir(cwd);
    const nextJobs = pruneJobs(state.jobs ?? []);
    const nextState = {
      version: STATE_VERSION,
      config: {
        ...defaultState().config,
        ...(state.config ?? {})
      },
      jobs: nextJobs
    };

    const retainedIds = new Set(nextJobs.map((job) => job.id));
    for (const job of previousJobs) {
      if (retainedIds.has(job.id)) {
        continue;
      }
      removeJobFile(resolveJobFile(cwd, job.id));
      removeFileIfExists(job.logFile);
    }

    const stateFile = resolveStateFile(cwd);
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, stateFile);
    return nextState;
  });
}

export function updateState(cwd, mutate) {
  return withStateLock(resolveStateDir(cwd), () => {
    const state = loadStateUnlocked(cwd);
    mutate(state);
    const previousJobs = state.jobs;
    ensureStateDir(cwd);
    const nextJobs = pruneJobs(state.jobs ?? []);
    const nextState = {
      version: STATE_VERSION,
      config: {
        ...defaultState().config,
        ...(state.config ?? {})
      },
      jobs: nextJobs
    };
    const retainedIds = new Set(nextJobs.map((job) => job.id));
    for (const job of previousJobs) {
      if (retainedIds.has(job.id)) {
        continue;
      }
      removeJobFile(resolveJobFile(cwd, job.id));
      removeFileIfExists(job.logFile);
    }
    const stateFile = resolveStateFile(cwd);
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, stateFile);
    return nextState;
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
