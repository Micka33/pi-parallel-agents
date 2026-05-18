import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const startScript = join(root, "scripts", "start-parallel-agent.sh");
const stateScript = join(root, "scripts", "parallel-agent-state.sh");
const fakePi = join(root, "tests", "fixtures", "fake-pi.mjs");
const skipUnderCoverage = process.env.PI_PARALLEL_AGENTS_COVERAGE === "1"
  ? { skip: "inline tool-path regression imports broad extension modules; covered by npm test" }
  : undefined;

function createRepo() {
  const parent = mkdtempSync(join(tmpdir(), "pa-start-"));
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

function testEnv(extra = {}) {
  return {
    ...process.env,
    PI_PARALLEL_AGENTS_PI_BIN: fakePi,
    PI_PARALLEL_AGENTS_DISABLE_NAMING_AGENT: "1",
    PI_PARALLEL_AGENTS_START_TIMEOUT_MS: "8000",
    ...extra,
  };
}

function runStart(repo, extraArgs, env = {}) {
  return JSON.parse(
    execFileSync(startScript, extraArgs, {
      cwd: repo,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: testEnv(env),
    }),
  );
}

function spawnStart(repo, extraArgs, env = {}) {
  const child = spawn(startScript, extraArgs, { cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: testEnv(env) });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`start process timed out; stdout=${stdout}; stderr=${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise(JSON.parse(stdout));
        return;
      }
      rejectPromise(new Error(`start process failed code=${code} signal=${signal}; stdout=${stdout}; stderr=${stderr}`));
    });
  });
  return { child, result };
}

function killPid(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

function stateDb(repo) {
  return join(repo, ".pi", "parallel-agents", "state.sqlite");
}

function tasksDb(repo) {
  return join(repo, ".pi", "parallel-agents", "tasks.sqlite");
}

function readRow(dbPath, sql, ...args) {
  if (!existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get(...args);
  } finally {
    db.close();
  }
}

function readAgent(repo, agentId) {
  return readRow(stateDb(repo), "SELECT * FROM agents WHERE agent_id = ?", agentId);
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

test("start-parallel-agent.sh creates a worktree, launches an SDK worker, and persists session state", () => {
  const { parent, repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, { name: "api", agentPrompt: "Inspect API" });
  const result = runStart(repo, ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high"]);

  try {
    assert.equal(result.agentId, "api");
    assert.equal(result.dedicatedWorktree, true);
    assert.equal(result.readOnly, false);
    assert.equal(result.model, "fake-model");
    assert.equal(result.thinking, "high");
    assert.match(result.sessionId, /^fake-session-/);
    assert.equal(result.status, "running");
    assert.equal(result.worktreePath, join(parent, "pi", "agent-api"));
    assert.equal(result.cwd, result.worktreePath);

    execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    const row = readAgent(repo, result.agentId);
    assert.equal(row.dedicated_worktree, 1);
    assert.equal(row.read_only, 0);
    assert.equal(row.worktree_path, result.worktreePath);
    assert.equal(row.branch_name, "agent-api");
    assert.equal(row.session_id, result.sessionId);
  } finally {
    killPid(result.pid);
  }
});

test("read-only SDK worker filters unsafe stored allowedTools at the final tools boundary", async () => {
  const { repo } = createRepo();
  const dbPath = stateDb(repo);
  execFileSync(stateScript, ["init", "--state-db", dbPath], { cwd: repo });

  const agentJson = join(repo, "unsafe-tools-agent.json");
  writeFileSync(
    agentJson,
    JSON.stringify({
      agent_id: "unsafe-tools",
      parent_session_id: "parent",
      display_name: "unsafe tools",
      repo_root: repo,
      status: "stopped",
      dedicated_worktree: 0,
      read_only: 1,
      cwd: repo,
      model: "fake-model",
      thinking: "high",
      max_sub_agents: 1,
      allowed_tools_json: JSON.stringify(["read", "some_mutating_extension_tool", "start_agent", "message_parallel_agent"]),
    }),
  );
  execFileSync(stateScript, ["upsert-agent", "--state-db", dbPath, "--agent-json", agentJson], { cwd: repo });

  const result = runStart(repo, ["--resume-session", "--agent-id", "unsafe-tools", "--state-db", dbPath, "--tasks-db", tasksDb(repo)]);
  try {
    const enqueued = JSON.parse(
      execFileSync(
        stateScript,
        ["enqueue-command", "--state-db", dbPath, "--agent-id", "unsafe-tools", "--command-type", "get_state", "--payload-json", JSON.stringify({ command: { type: "get_state" } })],
        { cwd: repo, encoding: "utf8" },
      ),
    );
    const command = await waitFor(() => {
      const row = readRow(dbPath, "SELECT * FROM agent_commands WHERE id = ?", enqueued.command.id);
      return row?.status === "succeeded" ? row : undefined;
    });
    const response = JSON.parse(command.response_json);
    assert.deepEqual(response.data.tools, ["read", "start_agent", "message_parallel_agent"]);
  } finally {
    killPid(result.pid);
  }
});

test("start-parallel-agent.sh supports shared checkout read-only mode without creating a worktree", () => {
  const { parent, repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, { name: "triage", agentPrompt: "Read only triage", dedicatedWorktree: false });
  const result = runStart(repo, ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high"]);

  try {
    assert.equal(result.dedicatedWorktree, false);
    assert.equal(result.readOnly, true);
    assert.equal(result.cwd, repo);
    assert.equal(result.worktreePath, null);
    assert.equal(result.branchName, null);
    const row = readAgent(repo, result.agentId);
    assert.equal(row.dedicated_worktree, 0);
    assert.equal(row.read_only, 1);
    assert.equal(existsSync(join(parent, "pi", "agent-triage")), false);
  } finally {
    killPid(result.pid);
  }
});

test("start-parallel-agent.sh supports singleResponse and cleans temporary worktree/session", () => {
  const { parent, repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, {
    name: "one-shot",
    agentPrompt: "Read once",
    singleResponse: true,
    readOnly: true,
  });
  const result = runStart(repo, ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high"]);

  assert.equal(result.ok, true);
  assert.equal(result.singleResponse, true);
  assert.equal(result.answer, "fake done");
  assert.equal(result.cleanup.worktreeRemoved, true);
  assert.equal(result.cleanup.branchRemoved, true);
  assert.equal(result.cleanup.sessionRemoved, true);
  assert.equal(existsSync(join(parent, "pi", "agent-one-shot")), false);
  assert.equal(readAgent(repo, result.agentId).status, "cleaned");
});

test("singleResponse cleans inherited context temp session file", () => {
  const { repo } = createRepo();
  const inheritedDir = join(repo, ".pi", "parallel-agents", "tmp");
  mkdirSync(inheritedDir, { recursive: true });
  const inheritedSessionFile = join(inheritedDir, "inherited-test.jsonl");
  writeFileSync(inheritedSessionFile, JSON.stringify({ type: "session", version: 3, id: "inherited", timestamp: new Date().toISOString(), cwd: repo }) + "\n");

  const { contextPath, promptPath } = writeLaunchFiles(repo, {
    name: "inherited-one-shot",
    agentPrompt: "Read inherited once",
    singleResponse: true,
    readOnly: true,
    inheritContext: true,
    inheritedSessionFile,
    inheritedSessionLeafId: "leaf-before-launch",
  });
  const result = runStart(repo, ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high"]);

  assert.equal(result.ok, true);
  assert.equal(result.cleanup.inheritedSessionRemoved, true);
  assert.equal(existsSync(inheritedSessionFile), false);
});

test("worker singleResponse bridges queue-backed ExtensionUIContext through durable queue", async () => {
  const { parent, repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, {
    name: "blocking-ui",
    agentPrompt: "ASK_UI_BLOCKING",
    singleResponse: true,
    readOnly: true,
  });

  const started = spawnStart(repo, ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high"], {
    PI_PARALLEL_AGENTS_COMMAND_POLL_MS: "50",
    PI_PARALLEL_AGENTS_SINGLE_RESPONSE_TIMEOUT_MS: "10000",
  });
  try {
    const incoming = await waitFor(() => readRow(tasksDb(repo), "SELECT * FROM parallel_questions WHERE question_id = ?", "ui-test"));
    assert.equal(incoming.agent_id, "blocking-ui");
    assert.equal(incoming.direction, "incoming");
    assert.equal(incoming.status, "queued");
    assert.equal(JSON.parse(incoming.metadata_json).transport, "ui_context");

    const payload = JSON.stringify({ questionId: "ui-test", response: "queued answer", command: { type: "extension_ui_response", id: "ui-test", value: "queued answer" } });
    const enqueued = JSON.parse(
      execFileSync(
        stateScript,
        ["enqueue-command", "--state-db", stateDb(repo), "--agent-id", "blocking-ui", "--command-type", "extension_ui_response", "--payload-json", payload],
        { cwd: repo, encoding: "utf8" },
      ),
    );

    const result = await started.result;
    assert.equal(result.ok, true);
    assert.equal(result.answer, "ui answer queued answer");
    assert.equal(existsSync(join(parent, "pi", "agent-blocking-ui")), false);

    const answered = readRow(tasksDb(repo), "SELECT * FROM parallel_questions WHERE question_id = ?", "ui-test");
    assert.equal(answered.status, "answered");
    assert.equal(answered.response, "queued answer");
    const command = readRow(stateDb(repo), "SELECT * FROM agent_commands WHERE id = ?", enqueued.command.id);
    assert.equal(command.status, "succeeded");
  } finally {
    if (started.child.exitCode === null && started.child.signalCode === null) started.child.kill("SIGTERM");
  }
});

test("timed-out singleResponse cleans temporary worktree and branch", () => {
  const { parent, repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, {
    name: "slow-one-shot",
    agentPrompt: "SLOW_RESPONSE",
    singleResponse: true,
    readOnly: true,
  });

  assert.throws(
    () =>
      runStart(repo, ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high"], {
        PI_PARALLEL_AGENTS_SINGLE_RESPONSE_TIMEOUT_MS: "100",
      }),
    /Timed out waiting for supervisor result file/,
  );

  assert.equal(existsSync(join(parent, "pi", "agent-slow-one-shot")), false);
  const branches = execFileSync("git", ["branch", "--list", "agent-slow-one-shot"], { cwd: repo, encoding: "utf8" });
  assert.equal(branches.trim(), "");
  const row = readAgent(repo, "slow-one-shot");
  assert.equal(row.status, "crashed");
  assert.match(row.last_error, /singleResponse interrupted/);
});

test("singleResponse runs with the child identity so nested starts are charged to the child", () => {
  const { parent, repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, {
    name: "quota-child",
    agentPrompt: "REPORT_AGENT_ID",
    singleResponse: true,
    readOnly: true,
    maxSubAgents: 1,
  });
  const result = runStart(
    repo,
    ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high"],
    { PI_PARALLEL_AGENTS_AGENT_ID: "parent-agent" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.agentId, "quota-child");
  assert.equal(result.answer, "agent id quota-child");
  assert.equal(existsSync(join(parent, "pi", "agent-quota-child")), false);
  const row = readAgent(repo, result.agentId);
  assert.equal(row.max_sub_agents, 1);
  assert.equal(row.status, "cleaned");
});

test("inline singleResponse enforces the requester maxSubAgents quota", skipUnderCoverage, () => {
  const { repo } = createRepo();
  const stateDb = join(repo, ".pi", "parallel-agents", "state.sqlite");
  execFileSync(stateScript, ["init", "--state-db", stateDb], { cwd: repo });

  const parentJson = join(repo, "parent-agent.json");
  writeFileSync(
    parentJson,
    JSON.stringify({
      agent_id: "blocked-parent",
      parent_session_id: "root",
      display_name: "blocked parent",
      repo_root: repo,
      status: "running",
      dedicated_worktree: 0,
      read_only: 1,
      cwd: repo,
      model: "fake-model",
      thinking: "high",
      max_sub_agents: 0,
    }),
  );
  execFileSync(stateScript, ["upsert-agent", "--state-db", stateDb, "--agent-json", parentJson], { cwd: repo });

  const moduleUrl = pathToFileURL(join(root, "dist", "src", "tools", "start-agent.js")).href;
  const code = `
const { startAgent } = await import(${JSON.stringify(moduleUrl)});
const ctx = {
  cwd: ${JSON.stringify(repo)},
  model: { provider: "fake-provider", id: "fake-model" },
  sessionManager: { getSessionFile: () => undefined, getEntries: () => [] }
};
try {
  await startAgent({ repoRoot: ${JSON.stringify(repo)}, prompt: "quick read", dedicatedWorktree: false, readOnly: true, singleResponse: true, maxSubAgents: 0 }, ctx, ["read"], "high");
  console.log("unexpected success");
  process.exit(1);
} catch (error) {
  console.log(error.message);
}
`;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PI_PARALLEL_AGENTS_AGENT_ID: "blocked-parent" },
  });
  assert.match(output, /Sub-agent limit exceeded for requester blocked-parent/);
});

test("start-parallel-agent.sh fails clearly when dedicated worktree is requested outside a git repo", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "pa-nongit-")));
  const { contextPath, promptPath } = writeLaunchFiles(repo, { name: "nogit", agentPrompt: "Should fail", dedicatedWorktree: true });

  assert.throws(
    () => runStart(repo, ["--context", contextPath, "--prompt", promptPath, "--model", "fake-model", "--thinking", "high"]),
    /dedicatedWorktree=true requires a git repository/,
  );
});
