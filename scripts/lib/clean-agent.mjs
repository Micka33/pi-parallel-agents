#!/usr/bin/env node
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { appendEvent, getAgent, openStateDb, setAgentStatus } from "./state-db.mjs";

const ACTIVE_STATUSES = new Set(["starting", "running", "waiting"]);

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const stateDb = required(options, "state-db");
  const agentId = required(options, "agent-id");
  const removeWorktree = booleanOption(options, "remove-worktree");
  const removeBranch = booleanOption(options, "remove-branch");
  const removeSession = booleanOption(options, "remove-session");
  const deleteHistory = booleanOption(options, "delete-history");
  const force = booleanOption(options, "force");

  const db = openStateDb(resolve(stateDb));
  try {
    const agent = getAgent(db, agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);

    const actions = [];
    if (agent.pid && isPidAlive(Number(agent.pid))) {
      if (ACTIVE_STATUSES.has(agent.status)) {
        throw new Error(`Agent ${agentId} is still ${agent.status}; run /agents-stop ${agentId} before clean`);
      }
      const stopped = stopPid(Number(agent.pid), 1000);
      actions.push({ type: "worker_stopped", pid: Number(agent.pid), previousStatus: agent.status, stopped });
      if (!stopped && isPidAlive(Number(agent.pid))) {
        throw new Error(`Agent ${agentId} is marked ${agent.status}, but worker process ${agent.pid} is still alive; run /agents-stop ${agentId} before clean`);
      }
    }

    if (removeWorktree && agent.worktree_path) {
      assertCleanWorktree(agent.worktree_path, force);
      const result = spawnSync("git", ["-C", agent.repo_root, "worktree", "remove", agent.worktree_path, ...(force ? ["--force"] : [])], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git worktree remove failed: ${result.stderr || result.stdout}`);
      actions.push({ type: "worktree_removed", path: agent.worktree_path });
    }

    if (removeBranch && agent.branch_name) {
      const result = spawnSync("git", ["-C", agent.repo_root, "branch", force ? "-D" : "-d", agent.branch_name], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git branch delete failed: ${result.stderr || result.stdout}`);
      actions.push({ type: "branch_removed", branch: agent.branch_name });
    }

    if (removeSession && agent.session_file && existsSync(agent.session_file)) {
      rmSync(agent.session_file, { force: true });
      actions.push({ type: "session_removed", sessionFile: agent.session_file });
    }

    appendEvent(db, { agentId, eventType: "clean", payloadJson: JSON.stringify({ actions, removeWorktree, removeBranch, removeSession, deleteHistory, force }) });
    let updated = setAgentStatus(db, { agentId, status: "cleaned", pid: null, lastError: null });
    if (deleteHistory) {
      db.prepare("DELETE FROM agents WHERE agent_id = ?").run(agentId);
      updated = null;
    }
    process.stdout.write(JSON.stringify({ ok: true, action: "clean", agent: updated, actions, deletedHistory: deleteHistory }, null, 2) + "\n");
  } finally {
    db.close();
  }
}

function assertCleanWorktree(path, force) {
  if (force) return;
  const result = spawnSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not inspect worktree status: ${result.stderr || result.stdout}`);
  if (result.stdout.trim()) throw new Error(`Refusing to remove dirty worktree ${path}; pass force=true to override`);
}

function stopPid(pid, timeoutMs) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true;
  }
  if (waitUntilDead(pid, timeoutMs)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return true;
  }
  waitUntilDead(pid, 1000);
  return true;
}

function waitUntilDead(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return !isPidAlive(pid);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { options };
}

function booleanOption(options, key) {
  const value = options[key];
  return value === true || value === "true" || value === "1" || value === "yes";
}

function required(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === "") throw new Error(`Missing --${key}`);
  return String(value);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
