import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsOpenArgumentCompletions } from "../../dist/src/commands/agents-open-completions.js";
import { openStateDb, initializeState, upsertAgent } from "../../scripts/lib/state-db.mjs";

function createAgent(repoRoot, overrides) {
  const agentId = overrides.agent_id;
  return {
    agent_id: agentId,
    parent_session_id: "parent-session",
    display_name: agentId,
    repo_root: repoRoot,
    status: "waiting",
    workspace_mode: "current",
    access_mode: "read_only",
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
    upsertAgent(db, createAgent(repoRoot, { agent_id: "zzz", display_name: "zzz", status: "waiting", workspace_mode: "worktree", model: null, thinking: null }));
    upsertAgent(db, createAgent(repoRoot, { agent_id: "aaa", display_name: "aaa", status: "waiting", workspace_mode: "worktree", model: null, thinking: null }));
    db.prepare("UPDATE agents SET updated_at = ? WHERE agent_id = ?").run("2026-01-01T00:00:00.000Z", "zzz");
    db.prepare("UPDATE agents SET updated_at = ? WHERE agent_id = ?").run("2026-01-01T00:00:00.000Z", "aaa");
  } finally {
    db.close();
  }

  const matches = agentsOpenArgumentCompletions("waiting worktree", repoRoot);
  assert.deepEqual(matches?.map((item) => item.value), ["aaa", "zzz"]);
  assert.equal(matches?.[0]?.label, "aaa");
  assert.match(matches?.[0]?.description ?? "", /worktree · \?\/\?/);

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
