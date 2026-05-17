import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { initializeState, openStateDb, upsertAgent } from "../../scripts/lib/state-db.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const consultScript = join(root, "scripts", "consult-subagent-clone.sh");
const fakePi = join(root, "tests", "fixtures", "fake-pi-rpc.mjs");

function createRepo() {
  const parent = mkdtempSync(join(tmpdir(), "pa-consult-"));
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

function stateDb(repo) {
  return join(repo, ".pi", "parallel-agents", "state.sqlite");
}

function insertAgent({ repo, parent, workspaceMode = "worktree", status = "waiting" }) {
  const dbPath = stateDb(repo);
  const sourceWorktree = workspaceMode === "worktree" ? join(parent, "pi", "source-agent") : repo;
  if (workspaceMode === "worktree") {
    mkdirSync(join(parent, "pi"), { recursive: true });
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "source-agent", sourceWorktree, "HEAD"], { stdio: "ignore" });
  }
  const sessionFile = join(parent, "source-session.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ sessionId: "source-session" }) + "\n");
  const db = openStateDb(dbPath);
  try {
    initializeState(db);
    upsertAgent(db, {
      agent_id: "source-agent",
      parent_session_id: "parent",
      display_name: "source-agent",
      repo_root: repo,
      status,
      workspace_mode: workspaceMode,
      access_mode: workspaceMode === "worktree" ? "write" : "read_only",
      pid: null,
      cwd: sourceWorktree,
      worktree_path: workspaceMode === "worktree" ? sourceWorktree : null,
      branch_name: workspaceMode === "worktree" ? "source-agent" : null,
      provider: "fake",
      model: "fake-model",
      thinking: "high",
      session_id: "source-session",
      session_file: sessionFile,
    });
  } finally {
    db.close();
  }
  return { dbPath, sourceWorktree, sessionFile };
}

test("consult-subagent-clone.sh runs an isolated read-only clone and cleans it up", () => {
  const { parent, repo } = createRepo();
  const { dbPath, sourceWorktree } = insertAgent({ repo, parent });

  const result = JSON.parse(
    execFileSync(consultScript, ["--state-db", dbPath, "--agent-id", "source-agent", "--question", "What changed?", "--timeout-ms", "5000"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PI_PARALLEL_AGENTS_PI_BIN: fakePi },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.answer, "fake done");
  assert.equal(result.thinking, "xhigh");
  assert.equal(result.source.worktreePath, sourceWorktree);
  assert.equal(result.cleanup.worktreeRemoved, true);
  assert.equal(result.cleanup.branchRemoved, true);
  assert.equal(result.cleanup.sessionRemoved, true);
  assert.equal(existsSync(result.clone.worktreePath), false);
  assert.throws(() => execFileSync("git", ["-C", repo, "rev-parse", "--verify", result.clone.branchName], { stdio: "pipe" }));
});

test("consult-subagent-clone.sh refuses current-workspace agents", () => {
  const { parent, repo } = createRepo();
  const { dbPath } = insertAgent({ repo, parent, workspaceMode: "current" });

  const result = spawnSync(consultScript, ["--state-db", dbPath, "--agent-id", "source-agent", "--question", "Nope"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PI_PARALLEL_AGENTS_PI_BIN: fakePi },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires workspaceMode=worktree/);
});
