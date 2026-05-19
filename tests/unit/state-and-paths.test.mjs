import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { statusGlyph, toParallelAgent } from "../../dist/src/state/selectors.js";
import { StateReader } from "../../dist/src/state/state-reader.js";
import { getParallelAgents } from "../../dist/src/tools/get-parallel-agents.js";
import { renderAgentDetails, renderAgentLine, renderAgentsList, renderAgentsSummary } from "../../dist/src/tui/render-agents.js";
import { renderQueueLine, renderQueueList } from "../../dist/src/tui/render-queues.js";
import { updateParallelAgentsWidget } from "../../dist/src/tui/widget.js";
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
    dedicated_worktree: 0,
    read_only: 1,
    cwd: repoRoot,
    model: "model",
    thinking: "high",
    ...overrides,
  });
}

function agent(overrides = {}) {
  return {
    agentId: "agent",
    displayName: "Agent",
    parentSessionId: "parent",
    repoRoot: "/repo",
    status: "waiting",
    dedicatedWorktree: false,
    readOnly: true,
    singleResponse: false,
    inheritContext: false,
    maxSubAgents: 0,
    allowedTools: null,
    systemPrompt: null,
    requesterAgentId: null,
    pid: null,
    cwd: "/repo",
    worktreePath: null,
    branchName: null,
    provider: "provider",
    model: "model",
    thinking: "high",
    sessionId: null,
    sessionFile: null,
    summary: null,
    diffSummary: null,
    testsJson: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

test("selectors map rows, optional collections, and all status glyphs", () => {
  const row = {
    agent_id: "agent",
    display_name: "Agent",
    parent_session_id: "parent",
    repo_root: "/repo",
    status: "running",
    requester_agent_id: null,
    dedicated_worktree: 1,
    read_only: 0,
    single_response: 0,
    inherit_context: 0,
    max_sub_agents: 0,
    allowed_tools_json: null,
    system_prompt: null,
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
    requesterAgentId: null,
    dedicatedWorktree: true,
    readOnly: false,
    singleResponse: false,
    inheritContext: false,
    maxSubAgents: 0,
    allowedTools: null,
    systemPrompt: null,
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

  const rowWithMetadata = {
    ...row,
    requester_agent_id: "requester",
    dedicated_worktree: 1,
    read_only: 1,
    single_response: 1,
    inherit_context: 1,
    max_sub_agents: 3,
    allowed_tools_json: JSON.stringify(["read", "grep"]),
    system_prompt: "extra system",
  };
  assert.deepEqual(toParallelAgent(rowWithMetadata), {
    ...toParallelAgent(row),
    requesterAgentId: "requester",
    dedicatedWorktree: true,
    readOnly: true,
    singleResponse: true,
    inheritContext: true,
    maxSubAgents: 3,
    allowedTools: ["read", "grep"],
    systemPrompt: "extra system",
  });
  assert.equal(toParallelAgent({ ...rowWithMetadata, allowed_tools_json: "not-json" }).allowedTools, null);
  assert.equal(toParallelAgent({ ...rowWithMetadata, allowed_tools_json: JSON.stringify("read") }).allowedTools, null);
  assert.deepEqual(toParallelAgent({ ...rowWithMetadata, allowed_tools_json: JSON.stringify(["read", 1, false, "ls"]) }).allowedTools, ["read", "ls"]);

  assert.deepEqual(
    ["running", "starting", "waiting", "stopped", "crashed", "done", "cleaned", "unknown"].map(statusGlyph),
    ["●", "◌", "○", "◼", "✖", "✓", "·", "?"],
  );
});

test("TUI renderers cover agent lines, details, summaries, and queues", () => {
  const base = agent({ sessionId: "session-id-longer-than-short", summary: "summary" });
  const worktree = agent({
    agentId: "worktree-agent",
    displayName: "Worktree Agent",
    status: "done",
    dedicatedWorktree: true,
    readOnly: false,
    pid: 123,
    cwd: "/repo/worktrees/agent",
    worktreePath: "/repo/worktrees/agent",
    branchName: "agent-branch",
    model: null,
    thinking: null,
    sessionId: null,
    sessionFile: "/sessions/agent.jsonl",
    lastError: "boom",
    commands: [
      { id: 1, command_type: "steer", status: "succeeded", last_error: null },
      { id: 2, command_type: "queue", status: "failed", last_error: "blocked" },
    ],
    queue: [
      {
        question_id: "q1",
        agent_id: "worktree-agent",
        direction: "incoming",
        mode: "reply",
        status: "queued",
        message: "short message",
        response: "short response",
        metadata_json: null,
        created_at: "now",
        updated_at: "now",
        delivered_at: null,
        answered_at: null,
      },
    ],
    events: Array.from({ length: 9 }, (_, index) => ({
      id: index + 1,
      agent_id: "worktree-agent",
      event_type: `event-${index}`,
      payload_json: index === 8 ? null : "x".repeat(130),
      created_at: "now",
    })),
  });
  const sharedWrite = agent({ readOnly: false, sessionId: "short" });
  const outside = agent({ cwd: "/outside/agent" });

  assert.match(renderAgentLine(base, "/repo"), /session session-id-/);
  assert.match(renderAgentLine(sharedWrite, "/repo"), /session short/);
  assert.match(renderAgentLine(worktree, "/repo"), /worktrees\/agent · session file/);
  assert.match(renderAgentLine(outside, "/repo"), /\/outside\/agent · no session/);
  assert.equal(renderAgentsList([], "/repo"), "No parallel agents recorded for this repo.");
  assert.match(renderAgentsList([base], "/repo"), /Agent/);

  const details = renderAgentDetails(worktree, "/repo");
  assert.match(details, /- worktree: worktrees\/agent/);
  assert.match(details, /- branch: agent-branch/);
  assert.match(details, /- model\/thinking: \?\/\?/);
  assert.match(details, /- pid: 123/);
  assert.match(details, /- lastError: boom/);
  assert.match(details, /#1 steer\/succeeded/);
  assert.match(details, /#2 queue\/failed: blocked/);
  assert.match(details, /← q1 reply\/queued: short message · response: short response/);
  assert.match(details, /event-8/);
  assert.match(renderAgentDetails(sharedWrite, "/repo"), /shares the parent checkout; write access blocked by default/);
  assert.match(renderAgentDetails(base, "/repo"), /shares the parent checkout; read-only tools only/);
  assert.match(renderAgentDetails(agent({ queue: [] }), "/repo"), /No queued questions/);

  assert.equal(renderAgentsSummary([], "/repo"), "No parallel agents recorded for this repo.");
  assert.match(renderAgentsSummary([base, agent({ summary: null })], "/repo"), /summary/);

  assert.match(
    renderQueueLine({
      question_id: "q2",
      agent_id: "agent",
      direction: "outgoing",
      mode: "queue",
      status: "blocked",
      message: "m".repeat(130),
      response: "r".repeat(90),
      metadata_json: null,
      created_at: "now",
      updated_at: "now",
      delivered_at: null,
      answered_at: null,
    }),
    /→ q2 queue\/blocked: m+… · response: r+…/,
  );
  assert.match(
    renderQueueLine({
      question_id: "q3",
      agent_id: "agent",
      direction: "incoming",
      mode: "reply",
      status: "done",
      message: "no response",
      response: null,
      metadata_json: null,
      created_at: "now",
      updated_at: "now",
      delivered_at: null,
      answered_at: null,
    }),
    /← q3 reply\/done: no response$/,
  );
  assert.equal(renderQueueList(undefined), "No queued questions.");
  assert.equal(renderQueueList([]), "No queued questions.");
  assert.match(renderQueueList(worktree.queue), /q1/);
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

test("getParallelAgents returns compact public rows only", () => {
  const { repoRoot, db } = createStateDb();
  try {
    insertAgent(db, repoRoot, "first", {
      display_name: "First Agent",
      status: "running",
      session_id: "session-1",
      pid: 123,
      summary: "hidden",
      last_error: "hidden",
    });
  } finally {
    db.close();
  }

  const result = getParallelAgents({ include: ["logs", "commands", "queues"] }, { cwd: repoRoot });
  assert.deepEqual(result, [{ agentId: "first", displayName: "First Agent", sessionId: "session-1", status: "running" }]);
  assert.deepEqual(Object.keys(result[0]).sort(), ["agentId", "displayName", "sessionId", "status"].sort());
  assert.deepEqual(getParallelAgents({ repoRoot, agentId: "first" }, { cwd: "/unused" }), result);
});

test("widget omits cleaned agents and clears when no visible agents remain", () => {
  const { repoRoot, db } = createStateDb();
  try {
    insertAgent(db, repoRoot, "hidden-cleaned", { status: "cleaned" });
    insertAgent(db, repoRoot, "visible-waiting", { status: "waiting" });
  } finally {
    db.close();
  }

  const widgets = [];
  const ctx = {
    cwd: repoRoot,
    ui: {
      setWidget(key, value) {
        widgets.push({ key, value });
      },
    },
  };

  updateParallelAgentsWidget(ctx, repoRoot);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0].key, "parallel-agents");
  assert.ok(widgets[0].value.some((line) => line.includes("visible-waiting")));
  assert.ok(widgets[0].value.every((line) => !line.includes("hidden-cleaned")));

  const { repoRoot: cleanedOnlyRoot, db: cleanedOnlyDb } = createStateDb();
  try {
    insertAgent(cleanedOnlyDb, cleanedOnlyRoot, "only-cleaned", { status: "cleaned" });
  } finally {
    cleanedOnlyDb.close();
  }
  updateParallelAgentsWidget(ctx, cleanedOnlyRoot);
  assert.deepEqual(widgets.at(-1), { key: "parallel-agents", value: undefined });
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
