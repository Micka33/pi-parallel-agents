import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createQuestion, openQueueDb } from "../../scripts/lib/queue-db.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const startScript = join(root, "scripts", "start-parallel-agent.sh");
const stopScript = join(root, "scripts", "stop-parallel-agent.sh");
const stateScript = join(root, "scripts", "parallel-agent-state.sh");
const fakePi = join(root, "tests", "fixtures", "fake-pi-rpc.mjs");

function createRepo() {
  const parent = mkdtempSync(join(tmpdir(), "pa-v2-"));
  const repo = join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# temp repo\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  return { parent: realpathSync(parent), repo: realpathSync(repo) };
}

function writeLaunchFiles(repo, fields) {
  const runtime = join(repo, ".pi", "parallel-agents", "tmp-test");
  mkdirSync(runtime, { recursive: true });
  const contextPath = join(runtime, `context-${Date.now()}-${Math.random()}.json`);
  const promptPath = join(runtime, `prompt-${Date.now()}-${Math.random()}.md`);
  writeFileSync(contextPath, JSON.stringify({ repoRoot: repo, parentSessionId: "parent", ...fields }, null, 2));
  writeFileSync(promptPath, fields.agentPrompt ?? "Do a fake task");
  return { contextPath, promptPath };
}

function env(extra = {}) {
  return {
    ...process.env,
    PI_PARALLEL_AGENTS_PI_BIN: fakePi,
    PI_PARALLEL_AGENTS_DISABLE_NAMING_AGENT: "1",
    PI_PARALLEL_AGENTS_START_TIMEOUT_MS: "8000",
    PI_PARALLEL_AGENTS_COMMAND_POLL_MS: "50",
    ...extra,
  };
}

function runStart(repo, extraArgs) {
  return JSON.parse(
    execFileSync(startScript, extraArgs, {
      cwd: repo,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: env(),
    }),
  );
}

function stateDb(repo) {
  return join(repo, ".pi", "parallel-agents", "state.sqlite");
}

function tasksDb(repo) {
  return join(repo, ".pi", "parallel-agents", "tasks.sqlite");
}

function readRow(dbPath, sql, ...args) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get(...args);
  } finally {
    db.close();
  }
}

function killPid(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

async function waitFor(fn, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  assert.fail("timed out waiting for condition");
}

test("stop-parallel-agent.sh stops an agent and resume starts a waiting RPC session", async () => {
  const { repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, { name: "control", workspaceMode: "current", agentPrompt: "Control me" });
  const result = runStart(repo, ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high", "--workspace-mode", "current"]);

  const stopped = JSON.parse(execFileSync(stopScript, ["--state-db", stateDb(repo), "--agent-id", result.agentId], { cwd: repo, encoding: "utf8" }));
  assert.equal(stopped.agent.status, "stopped");
  assert.equal(stopped.agent.pid, null);

  const resumed = runStart(repo, ["--resume-session", "--agent-id", result.agentId, "--state-db", stateDb(repo), "--tasks-db", tasksDb(repo)]);
  try {
    assert.equal(resumed.agentId, result.agentId);
    assert.equal(resumed.status, "waiting");
    assert.ok(resumed.pid);
    assert.equal(existsSync(resumed.sessionFile), true);
  } finally {
    killPid(resumed.pid);
  }
});

test("supervisor ignores fire-and-forget extension UI requests", async () => {
  const { repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, { name: "fire-forget", workspaceMode: "current", agentPrompt: "FIRE_AND_FORGET_UI" });
  const result = runStart(repo, ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high", "--workspace-mode", "current"]);

  try {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const row = readRow(tasksDb(repo), "SELECT * FROM parallel_questions WHERE question_id = ?", "fire-and-forget-test");
    assert.equal(row, undefined);
  } finally {
    killPid(result.pid);
  }
});

test("supervisor bridges extension_ui_request and extension_ui_response through durable questions", async () => {
  const { repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, { name: "bridge", workspaceMode: "current", agentPrompt: "ASK_UI" });
  const result = runStart(repo, ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high", "--workspace-mode", "current"]);

  try {
    const incoming = await waitFor(() => readRow(tasksDb(repo), "SELECT * FROM parallel_questions WHERE question_id = ?", "ui-test"));
    assert.equal(incoming.direction, "incoming");
    assert.equal(incoming.status, "queued");

    const payload = JSON.stringify({ questionId: "ui-test", response: "answer", rpc: { type: "extension_ui_response", id: "ui-test", value: "answer" } });
    const enqueued = JSON.parse(
      execFileSync(
        stateScript,
        ["enqueue-command", "--state-db", stateDb(repo), "--agent-id", result.agentId, "--command-type", "extension_ui_response", "--payload-json", payload],
        { cwd: repo, encoding: "utf8" },
      ),
    );

    await waitFor(() => {
      const row = readRow(stateDb(repo), "SELECT * FROM agent_commands WHERE id = ?", enqueued.command.id);
      return row?.status === "succeeded" ? row : undefined;
    });
    const answered = readRow(tasksDb(repo), "SELECT * FROM parallel_questions WHERE question_id = ?", "ui-test");
    assert.equal(answered.status, "answered");
    assert.equal(answered.response, "answer");
  } finally {
    killPid(result.pid);
  }
});

test("supervisor delivers queued RPC commands and marks durable questions delivered", async () => {
  const { repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, { name: "messaging", workspaceMode: "current", agentPrompt: "Message me" });
  const result = runStart(repo, ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high", "--workspace-mode", "current"]);

  try {
    const qdb = openQueueDb(tasksDb(repo));
    try {
      createQuestion(qdb, {
        questionId: "q-test",
        agentId: result.agentId,
        direction: "outgoing",
        mode: "queue",
        status: "queued",
        message: "Please continue",
      });
    } finally {
      qdb.close();
    }

    const payload = JSON.stringify({ questionId: "q-test", rpc: { type: "follow_up", message: "Please continue" } });
    const enqueued = JSON.parse(
      execFileSync(
        stateScript,
        ["enqueue-command", "--state-db", stateDb(repo), "--agent-id", result.agentId, "--command-type", "follow_up", "--payload-json", payload],
        { cwd: repo, encoding: "utf8" },
      ),
    );
    assert.equal(enqueued.command.status, "queued");

    const command = await waitFor(() => {
      const row = readRow(stateDb(repo), "SELECT * FROM agent_commands WHERE id = ?", enqueued.command.id);
      return row?.status === "succeeded" ? row : undefined;
    });
    assert.equal(command.command_type, "follow_up");

    const question = readRow(tasksDb(repo), "SELECT * FROM parallel_questions WHERE question_id = ?", "q-test");
    assert.equal(question.status, "delivered");
    const piTask = readRow(tasksDb(repo), "SELECT * FROM tasks WHERE id = ?", "q-test");
    assert.equal(piTask.status, "todo");
    assert.match(piTask.notes, /parallelQuestionId/);
  } finally {
    killPid(result.pid);
  }
});
