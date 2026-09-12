#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { saveTurnBaseline } from "./lib/git.mjs";
import { resolveStateDir } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

try {
  const input = readHookInput();
  const cwd = resolveWorkspaceRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const sessionId = input.session_id || input.sessionId || process.env.CLAUDE_SESSION_ID || "";
  saveTurnBaseline(cwd, resolveStateDir(cwd), sessionId);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
}
