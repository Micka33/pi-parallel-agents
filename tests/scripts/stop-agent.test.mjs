import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { initializeState, openStateDb, upsertAgent } from "../../scripts/lib/state-db.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const stopScript = join(root, "scripts", "stop-parallel-agent.sh");

function createStateDb() {
  const repoRoot = mkdtempSync(join(tmpdir(), "pa-stop-"));
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
      workspace_mode: "current",
      access_mode: "read_only",
      pid: null,
      cwd: repoRoot,
      provider: "openai-codex",
      model: "gpt-5.5",
      thinking: "high",
      session_id: "session-1",
      session_file: join(repoRoot, "session.jsonl"),
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

test("stop-parallel-agent.sh fails clearly for missing or unknown agents", () => {
  const { dbPath } = createStateDb();

  const missingAgentId = spawnSync(stopScript, ["--state-db", dbPath], { encoding: "utf8" });
  assert.notEqual(missingAgentId.status, 0);
  assert.match(missingAgentId.stderr, /Missing --agent-id/);

  const unknownAgent = spawnSync(stopScript, ["--state-db", dbPath, "--agent-id", "missing"], { encoding: "utf8" });
  assert.notEqual(unknownAgent.status, 0);
  assert.match(unknownAgent.stderr, /Unknown agent: missing/);
});

test("stop-parallel-agent.sh marks stale-pid agents stopped and records an event", () => {
  const { repoRoot, dbPath } = createStateDb();
  const stalePid = 999_999_999;
  insertAgent(dbPath, repoRoot, {
    agent_id: "stale",
    pid: stalePid,
    worktree_path: join(repoRoot, "worktree"),
    branch_name: "stale-branch",
    last_error: "previous error",
  });

  const result = JSON.parse(execFileSync(stopScript, ["--state-db", dbPath, "--agent-id", "stale"], { encoding: "utf8" }));
  assert.equal(result.ok, true);
  assert.equal(result.action, "stop");
  assert.equal(result.stopped, true);
  assert.equal(result.agent.status, "stopped");
  assert.equal(result.agent.pid, null);
  assert.equal(result.agent.last_error, null);

  // Stop only changes lifecycle fields; it must not clean evidence needed later.
  assert.equal(result.agent.worktree_path, join(repoRoot, "worktree"));
  assert.equal(result.agent.branch_name, "stale-branch");
  assert.equal(result.agent.session_id, "session-1");
  assert.equal(result.agent.session_file, join(repoRoot, "session.jsonl"));

  const persisted = readRow(dbPath, "SELECT status, pid, last_error FROM agents WHERE agent_id = ?", "stale");
  assert.equal(persisted.status, "stopped");
  assert.equal(persisted.pid, null);
  assert.equal(persisted.last_error, null);

  const event = readRow(dbPath, "SELECT event_type, payload_json FROM agent_events WHERE agent_id = ? ORDER BY id DESC LIMIT 1", "stale");
  assert.equal(event.event_type, "stop");
  assert.deepEqual(JSON.parse(event.payload_json), { pid: stalePid, stopped: true, timeoutMs: 3000 });
});

test("stop-parallel-agent.sh is idempotent for already-stopped agents", () => {
  const { repoRoot, dbPath } = createStateDb();
  insertAgent(dbPath, repoRoot, {
    agent_id: "already-stopped",
    status: "stopped",
    pid: null,
  });

  const first = JSON.parse(execFileSync(stopScript, ["--state-db", dbPath, "--agent-id", "already-stopped"], { encoding: "utf8" }));
  const second = JSON.parse(execFileSync(stopScript, ["--state-db", dbPath, "--agent-id", "already-stopped"], { encoding: "utf8" }));

  assert.equal(first.stopped, true);
  assert.equal(second.stopped, true);
  assert.equal(second.agent.status, "stopped");
  assert.equal(second.agent.pid, null);

  const eventCount = readRow(dbPath, "SELECT COUNT(*) AS count FROM agent_events WHERE agent_id = ? AND event_type = 'stop'", "already-stopped").count;
  assert.equal(eventCount, 2);
});
