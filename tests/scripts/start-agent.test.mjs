import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..", "..");
const startScript = join(root, "scripts", "start-parallel-agent.sh");
const fakePi = join(root, "tests", "fixtures", "fake-pi-rpc.mjs");

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

function runStart(repo, extraArgs, env = {}) {
  return JSON.parse(
    execFileSync(startScript, extraArgs, {
      cwd: repo,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_PARALLEL_AGENTS_PI_BIN: fakePi,
        PI_PARALLEL_AGENTS_DISABLE_NAMING_AGENT: "1",
        PI_PARALLEL_AGENTS_START_TIMEOUT_MS: "8000",
        ...env,
      },
    }),
  );
}

function killPid(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

function readAgent(repo, agentId) {
  const db = new DatabaseSync(join(repo, ".pi", "parallel-agents", "state.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId);
  } finally {
    db.close();
  }
}

test("start-parallel-agent.sh creates a worktree, launches Pi RPC, and persists session state", () => {
  const { parent, repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, { name: "api", agentPrompt: "Inspect API" });
  const result = runStart(repo, [
    "--context",
    contextPath,
    "--prompt",
    promptPath,
    "--model",
    "fake-model",
    "--thinking",
    "high",
    "--workspace-mode",
    "worktree",
  ]);

  try {
    assert.equal(result.agentId, "api");
    assert.equal(result.workspaceMode, "worktree");
    assert.equal(result.accessMode, "write");
    assert.equal(result.model, "fake-model");
    assert.equal(result.thinking, "high");
    assert.match(result.sessionId, /^fake-session-/);
    assert.equal(result.status, "running");
    assert.equal(result.worktreePath, join(parent, "pi", "agent-api"));
    assert.equal(result.cwd, result.worktreePath);

    execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    const row = readAgent(repo, result.agentId);
    assert.equal(row.workspace_mode, "worktree");
    assert.equal(row.worktree_path, result.worktreePath);
    assert.equal(row.branch_name, "agent-api");
    assert.equal(row.session_id, result.sessionId);
  } finally {
    killPid(result.pid);
  }
});

test("start-parallel-agent.sh supports current workspace read-only mode without creating a worktree", () => {
  const { parent, repo } = createRepo();
  const { contextPath, promptPath } = writeLaunchFiles(repo, { name: "triage", agentPrompt: "Read only triage", workspaceMode: "current" });
  const result = runStart(repo, [
    "--context",
    contextPath,
    "--prompt",
    promptPath,
    "--model",
    "fake-model",
    "--thinking",
    "high",
    "--workspace-mode",
    "current",
  ]);

  try {
    assert.equal(result.workspaceMode, "current");
    assert.equal(result.accessMode, "read_only");
    assert.equal(result.cwd, repo);
    assert.equal(result.worktreePath, null);
    assert.equal(result.branchName, null);
    assert.equal(readAgent(repo, result.agentId).access_mode, "read_only");
    // The default worktree path is never created for current/read_only launches.
    assert.equal(existsSync(join(parent, "pi", "agent-triage")), false);
  } finally {
    killPid(result.pid);
  }
});


test("start-parallel-agent.sh fails clearly when worktree mode is requested outside a git repo", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "pa-nongit-")));
  const { contextPath, promptPath } = writeLaunchFiles(repo, { name: "nogit", agentPrompt: "Should fail", workspaceMode: "worktree" });

  assert.throws(
    () =>
      runStart(repo, [
        "--context",
        contextPath,
        "--prompt",
        promptPath,
        "--model",
        "fake-model",
        "--thinking",
        "high",
        "--workspace-mode",
        "worktree",
      ]),
    /workspaceMode=worktree requires a git repository/,
  );
});
