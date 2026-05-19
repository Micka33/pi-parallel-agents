import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { initializeState, openStateDb, upsertAgent } from "../../scripts/lib/state-db.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const cleanScript = join(root, "scripts", "clean-parallel-agent.sh");

function createStateDb() {
  const repoRoot = mkdtempSync(join(tmpdir(), "pa-clean-"));
  const dbPath = join(repoRoot, ".pi", "parallel-agents", "state.sqlite");
  const db = openStateDb(dbPath);
  try {
    initializeState(db);
  } finally {
    db.close();
  }
  return { repoRoot, dbPath };
}

function insertAgent(dbPath, repoRoot, overrides = {}) {
  const agentId = overrides.agent_id ?? "agent";
  const db = openStateDb(dbPath);
  try {
    return upsertAgent(db, {
      agent_id: agentId,
      parent_session_id: "parent-session",
      display_name: agentId,
      repo_root: repoRoot,
      status: "waiting",
      dedicated_worktree: 0,
      read_only: 1,
      pid: null,
      cwd: repoRoot,
      provider: "openai-codex",
      model: "gpt-5.5",
      thinking: "high",
      ...overrides,
    });
  } finally {
    db.close();
  }
}

function readRow(dbPath, sql, ...args) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get(...args);
  } finally {
    db.close();
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("clean-parallel-agent.sh rejects active live agents with a friendly message", () => {
  const { repoRoot, dbPath } = createStateDb();
  insertAgent(dbPath, repoRoot, { agent_id: "active-agent", status: "waiting", pid: process.pid });

  const result = spawnSync(cleanScript, ["--state-db", dbPath, "--agent-id", "active-agent"], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Agent active-agent is still waiting; run \/agents-stop active-agent before clean/);
  assert.doesNotMatch(result.stderr, /at main/);
});

test("clean-parallel-agent.sh stops marked-done workers before cleaning", () => {
  const { repoRoot, dbPath } = createStateDb();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  assert.ok(child.pid);
  child.unref();

  try {
    insertAgent(dbPath, repoRoot, { agent_id: "done-agent", status: "done", pid: child.pid });

    const result = JSON.parse(execFileSync(cleanScript, ["--state-db", dbPath, "--agent-id", "done-agent"], { encoding: "utf8" }));

    assert.equal(result.ok, true);
    assert.equal(result.agent.status, "cleaned");
    assert.equal(result.agent.pid, null);
    assert.deepEqual(result.actions.map((action) => action.type), ["worker_stopped"]);

    const persisted = readRow(dbPath, "SELECT status, pid FROM agents WHERE agent_id = ?", "done-agent");
    assert.equal(persisted.status, "cleaned");
    assert.equal(persisted.pid, null);
  } finally {
    if (child.pid && isPidAlive(child.pid)) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
  }
});
