import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsCleanArgumentCompletions } from "../../dist/src/commands/agents-clean-completions.js";
import { agentsOpenArgumentCompletions } from "../../dist/src/commands/agents-open-completions.js";
import { agentsSummaryArgumentCompletions } from "../../dist/src/commands/agents-summary-completions.js";
import { openStateDb, initializeState, upsertAgent } from "../../scripts/lib/state-db.mjs";

function createAgent(repoRoot, overrides) {
  const agentId = overrides.agent_id;
  return {
    agent_id: agentId,
    parent_session_id: "parent-session",
    display_name: agentId,
    repo_root: repoRoot,
    status: "waiting",
    dedicated_worktree: 0,
    read_only: 1,
    cwd: repoRoot,
    model: "gpt-5.5",
    thinking: "high",
    ...overrides,
  };
}

test("agents-open argument completions suggest matching agent IDs for the current repo", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "pa-completions-"));
  const otherRepoRoot = mkdtempSync(join(tmpdir(), "pa-completions-other-"));
  const db = openStateDb(join(repoRoot, ".pi", "parallel-agents", "state.sqlite"));
  try {
    initializeState(db);
    upsertAgent(
      db,
      createAgent(repoRoot, {
        agent_id: "api-worker",
        display_name: "API Worker",
        status: "running",
      }),
    );
    upsertAgent(
      db,
      createAgent(repoRoot, {
        agent_id: "ui-reviewer",
        display_name: "UI Reviewer",
        status: "crashed",
        model: "gpt-5.5",
      }),
    );
    upsertAgent(
      db,
      createAgent(otherRepoRoot, {
        agent_id: "other-repo-agent",
        display_name: "Other Repo Agent",
      }),
    );
  } finally {
    db.close();
  }

  const apiMatches = agentsOpenArgumentCompletions("api", repoRoot);
  assert.deepEqual(apiMatches?.map((item) => item.value), ["api-worker"]);
  assert.equal(apiMatches?.[0]?.label, "API Worker (api-worker)");
  assert.match(apiMatches?.[0]?.description ?? "", /running/);

  const allMatches = agentsOpenArgumentCompletions("", repoRoot);
  assert.deepEqual(allMatches?.map((item) => item.value), ["api-worker", "ui-reviewer"]);

  assert.equal(agentsOpenArgumentCompletions("other", repoRoot), null);
});

test("agents-open argument completions cover sorting, fallback labels, and catch errors", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "pa-completions-branches-"));
  const db = openStateDb(join(repoRoot, ".pi", "parallel-agents", "state.sqlite"));
  try {
    initializeState(db);
    upsertAgent(db, createAgent(repoRoot, { agent_id: "zzz", display_name: "zzz", status: "waiting", dedicated_worktree: 1, read_only: 0, model: null, thinking: null }));
    upsertAgent(db, createAgent(repoRoot, { agent_id: "aaa", display_name: "aaa", status: "waiting", dedicated_worktree: 1, read_only: 0, model: null, thinking: null }));
    db.prepare("UPDATE agents SET updated_at = ? WHERE agent_id = ?").run("2026-01-01T00:00:00.000Z", "zzz");
    db.prepare("UPDATE agents SET updated_at = ? WHERE agent_id = ?").run("2026-01-01T00:00:00.000Z", "aaa");
  } finally {
    db.close();
  }

  const matches = agentsOpenArgumentCompletions("waiting worktree", repoRoot);
  assert.deepEqual(matches?.map((item) => item.value), ["aaa", "zzz"]);
  assert.equal(matches?.[0]?.label, "aaa");
  assert.match(matches?.[0]?.description ?? "", /worktree\/write · \?\/\?/);

  const brokenRepoRoot = mkdtempSync(join(tmpdir(), "pa-completions-broken-"));
  writeFileSync(join(brokenRepoRoot, ".broken-state"), "not a sqlite db");
  process.env.PI_PARALLEL_AGENTS_DB_PATH = ".broken-state";
  try {
    assert.equal(agentsOpenArgumentCompletions("anything", brokenRepoRoot), null);
  } finally {
    delete process.env.PI_PARALLEL_AGENTS_DB_PATH;
  }
});

test("agents-open argument completions are quiet when state is unavailable", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "pa-completions-empty-"));
  assert.equal(agentsOpenArgumentCompletions("anything", repoRoot), null);
  assert.equal(agentsOpenArgumentCompletions("anything", undefined), null);
});

test("agents-clean argument completions suggest agent ids then clean flags", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "pa-clean-completions-"));
  const db = openStateDb(join(repoRoot, ".pi", "parallel-agents", "state.sqlite"));
  try {
    initializeState(db);
    upsertAgent(db, createAgent(repoRoot, { agent_id: "api-worker", display_name: "API Worker", status: "stopped" }));
  } finally {
    db.close();
  }

  assert.deepEqual(agentsCleanArgumentCompletions("api", repoRoot)?.map((item) => item.value), ["api-worker"]);
  assert.deepEqual(agentsCleanArgumentCompletions("api-worker ", repoRoot)?.map((item) => item.value), [
    "--worktree",
    "--branch",
    "--session",
    "--delete-history",
    "--force",
  ]);
  assert.deepEqual(agentsCleanArgumentCompletions("api-worker --s", repoRoot)?.map((item) => item.value), ["--session"]);
  assert.deepEqual(agentsCleanArgumentCompletions("api-worker --session ", repoRoot)?.map((item) => item.value), [
    "--worktree",
    "--branch",
    "--delete-history",
    "--force",
  ]);
  assert.equal(agentsCleanArgumentCompletions("", repoRoot)?.length, 1);
  assert.equal(agentsCleanArgumentCompletions("--force", repoRoot), null);
  assert.equal(agentsCleanArgumentCompletions("--force ", repoRoot), null);
  assert.equal(agentsCleanArgumentCompletions("api-worker unexpected", repoRoot), null);
  assert.equal(agentsCleanArgumentCompletions("api-worker stray --s", repoRoot), null);
  assert.equal(agentsCleanArgumentCompletions("api-worker --missing", repoRoot), null);
  assert.equal(agentsCleanArgumentCompletions("api-worker --worktree --branch --session --delete-history --force ", repoRoot), null);
});

test("agents-summary argument completions suggest include-cleaned flags", () => {
  assert.deepEqual(agentsSummaryArgumentCompletions("")?.map((item) => item.value), ["--all", "--include-cleaned"]);
  assert.deepEqual(agentsSummaryArgumentCompletions(" ")?.map((item) => item.value), ["--all", "--include-cleaned"]);
  assert.deepEqual(agentsSummaryArgumentCompletions("--i")?.map((item) => item.value), ["--include-cleaned"]);
  assert.equal(agentsSummaryArgumentCompletions("--all "), null);
  assert.equal(agentsSummaryArgumentCompletions("agent-id"), null);
  assert.equal(agentsSummaryArgumentCompletions("--missing"), null);
});
