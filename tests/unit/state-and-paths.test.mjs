import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { statusGlyph, toParallelAgent } from "../../dist/src/state/selectors.js";
import { StateReader } from "../../dist/src/state/state-reader.js";
import { packageRoot, promptPath, resolveRepoRoot, runtimeDir, scriptPath, stateDbPath, tasksDbPath } from "../../dist/src/util/paths.js";
import { appendEvent, enqueueAgentCommand, initializeState, openStateDb, setDefaults, upsertAgent } from "../../scripts/lib/state-db.mjs";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createRepo() {
  const repo = tempDir("pa-paths-repo-");
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function createStateDb() {
  const repoRoot = tempDir("pa-reader-");
  const dbPath = join(repoRoot, ".pi", "parallel-agents", "state.sqlite");
  const db = openStateDb(dbPath);
  initializeState(db);
  return { repoRoot, dbPath, db };
}

function insertAgent(db, repoRoot, agentId, overrides = {}) {
  return upsertAgent(db, {
    agent_id: agentId,
    parent_session_id: "parent",
    display_name: agentId,
    repo_root: repoRoot,
    status: "waiting",
    workspace_mode: "current",
    access_mode: "read_only",
    cwd: repoRoot,
    model: "model",
    thinking: "high",
    ...overrides,
  });
}

test("selectors map rows, optional collections, and all status glyphs", () => {
  const row = {
    agent_id: "agent",
    display_name: "Agent",
    parent_session_id: "parent",
    repo_root: "/repo",
    status: "running",
    workspace_mode: "worktree",
    access_mode: "write",
    pid: 123,
    cwd: "/repo/wt",
    worktree_path: "/repo/wt",
    branch_name: "agent-branch",
    provider: "provider",
    model: "model",
    thinking: "high",
    session_id: "session",
    session_file: "session.jsonl",
    summary: "summary",
    diff_summary: "diff",
    tests_json: "{}",
    last_error: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
  };

  assert.deepEqual(toParallelAgent(row), {
    agentId: "agent",
    displayName: "Agent",
    parentSessionId: "parent",
    repoRoot: "/repo",
    status: "running",
    workspaceMode: "worktree",
    accessMode: "write",
    pid: 123,
    cwd: "/repo/wt",
    worktreePath: "/repo/wt",
    branchName: "agent-branch",
    provider: "provider",
    model: "model",
    thinking: "high",
    sessionId: "session",
    sessionFile: "session.jsonl",
    summary: "summary",
    diffSummary: "diff",
    testsJson: "{}",
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  });

  assert.deepEqual(toParallelAgent(row, [{ event_type: "event" }], [{ command_type: "command" }], [{ question_id: "q" }]), {
    ...toParallelAgent(row),
    events: [{ event_type: "event" }],
    commands: [{ command_type: "command" }],
    queue: [{ question_id: "q" }],
  });

  assert.deepEqual(
    ["running", "starting", "waiting", "stopped", "crashed", "done", "cleaned", "unknown"].map(statusGlyph),
    ["●", "◌", "○", "◼", "✖", "✓", "·", "?"],
  );
});

test("StateReader covers missing and populated state reads", () => {
  const missingReader = new StateReader(join(tempDir("pa-reader-missing-"), "missing.sqlite"));
  assert.equal(missingReader.exists(), false);
  assert.deepEqual(missingReader.readAgents(), []);
  assert.deepEqual(missingReader.readCommands("agent"), []);
  assert.deepEqual(missingReader.readEvents("agent"), []);
  assert.deepEqual(missingReader.readSettings(), {});

  const { repoRoot, dbPath, db } = createStateDb();
  try {
    const first = insertAgent(db, repoRoot, "first", { status: "running" });
    insertAgent(db, repoRoot, "second", { status: "waiting" });
    insertAgent(db, "/other", "other", { repo_root: "/other" });
    appendEvent(db, { agentId: "first", eventType: "older", payloadJson: "{}" });
    appendEvent(db, { agentId: "first", eventType: "newer", payloadJson: "{}" });
    enqueueAgentCommand(db, { agentId: "first", commandType: "older", payloadJson: { order: 1 } });
    enqueueAgentCommand(db, { agentId: "first", commandType: "newer", payloadJson: { order: 2 } });
    setDefaults(db, { model: "configured", thinking: "medium" });
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('raw', 'not-json', ?)").run(first.created_at);
  } finally {
    db.close();
  }

  const reader = new StateReader(dbPath);
  assert.equal(reader.exists(), true);
  assert.deepEqual(reader.readAgents({ agentId: "missing" }), []);
  assert.deepEqual(reader.readAgents({ agentId: "first" }).map((row) => row.agent_id), ["first"]);
  assert.deepEqual(reader.readAgents({ repoRoot }).map((row) => row.agent_id), ["first", "second"]);
  assert.deepEqual(reader.readAgents().map((row) => row.agent_id), ["first", "second", "other"]);
  assert.deepEqual(reader.readCommands("first", 2).map((row) => row.command_type), ["older", "newer"]);
  assert.deepEqual(reader.readEvents("first", 4).map((row) => row.event_type), ["older", "newer", "command_queued", "command_queued"]);
  assert.equal(reader.readSettings().default_model, "configured");
  assert.equal(reader.readSettings().raw, "not-json");
});

test("path helpers resolve package, runtime, database, and repository paths", () => {
  const root = packageRoot();
  assert.equal(scriptPath("start-parallel-agent.sh"), join(root, "scripts", "start-parallel-agent.sh"));
  assert.equal(promptPath("child-agent.md"), join(root, "src", "prompts", "child-agent.md"));

  const repoRoot = resolve("/tmp/example-repo");
  assert.equal(runtimeDir(repoRoot), join(repoRoot, ".pi", "parallel-agents"));
  assert.equal(stateDbPath(repoRoot), join(repoRoot, ".pi", "parallel-agents", "state.sqlite"));
  assert.equal(tasksDbPath(repoRoot), join(repoRoot, ".pi", "parallel-agents", "tasks.sqlite"));

  process.env.PI_PARALLEL_AGENTS_DB_PATH = "custom/state.sqlite";
  process.env.PI_TASKS_DB_PATH = "custom/tasks.sqlite";
  process.env.PI_PARALLEL_AGENTS_REPO_ROOT = "../override-root";
  try {
    assert.equal(stateDbPath(repoRoot), resolve(repoRoot, "custom/state.sqlite"));
    assert.equal(tasksDbPath(repoRoot), resolve(repoRoot, "custom/tasks.sqlite"));
    assert.equal(resolveRepoRoot(repoRoot), resolve("../override-root"));
  } finally {
    delete process.env.PI_PARALLEL_AGENTS_DB_PATH;
    delete process.env.PI_TASKS_DB_PATH;
    delete process.env.PI_PARALLEL_AGENTS_REPO_ROOT;
  }

  const repo = createRepo();
  const nested = join(repo, "nested");
  mkdirSync(nested);
  assert.equal(resolveRepoRoot(nested), realpathSync(repo));
  const notGit = tempDir("pa-not-git-");
  assert.equal(resolveRepoRoot(notGit), resolve(notGit));
});
