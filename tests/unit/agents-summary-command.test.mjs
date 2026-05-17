import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeState, openStateDb, upsertAgent } from "../../scripts/lib/state-db.mjs";

const skipUnderCoverage = process.env.PI_PARALLEL_AGENTS_COVERAGE === "1" ? { skip: "command imports broad tool modules; covered by npm test" } : undefined;

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

test("agents-summary hides cleaned agents unless requested", skipUnderCoverage, async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "pa-summary-command-"));
  const db = openStateDb(join(repoRoot, ".pi", "parallel-agents", "state.sqlite"));
  try {
    initializeState(db);
    upsertAgent(db, createAgent(repoRoot, { agent_id: "active-agent", status: "waiting", summary: "active summary" }));
    upsertAgent(db, createAgent(repoRoot, { agent_id: "cleaned-agent", status: "cleaned", summary: "cleaned summary" }));
  } finally {
    db.close();
  }

  const { agentsSummaryCommand } = await import("../../dist/src/commands/agents-summary.js");
  const notifications = [];
  const ctx = {
    cwd: repoRoot,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setWidget() {},
    },
  };

  await agentsSummaryCommand("", ctx);
  assert.match(notifications.at(-1).message, /active-agent/);
  assert.doesNotMatch(notifications.at(-1).message, /cleaned-agent/);

  await agentsSummaryCommand("--include-cleaned", ctx);
  assert.match(notifications.at(-1).message, /active-agent/);
  assert.match(notifications.at(-1).message, /cleaned-agent/);

  await agentsSummaryCommand("--all", ctx);
  assert.match(notifications.at(-1).message, /cleaned summary/);

  const cleanedOnlyRoot = mkdtempSync(join(tmpdir(), "pa-summary-cleaned-only-"));
  const cleanedOnlyDb = openStateDb(join(cleanedOnlyRoot, ".pi", "parallel-agents", "state.sqlite"));
  try {
    initializeState(cleanedOnlyDb);
    upsertAgent(cleanedOnlyDb, createAgent(cleanedOnlyRoot, { agent_id: "first-cleaned", status: "cleaned" }));
    upsertAgent(cleanedOnlyDb, createAgent(cleanedOnlyRoot, { agent_id: "second-cleaned", status: "cleaned" }));
  } finally {
    cleanedOnlyDb.close();
  }

  await agentsSummaryCommand("", { ...ctx, cwd: cleanedOnlyRoot });
  assert.equal(notifications.at(-1).message, "No parallel agents for this repo.\nUse /agents-summary --all to include cleaned agents (2).");

  const emptyRoot = mkdtempSync(join(tmpdir(), "pa-summary-empty-"));
  const emptyDb = openStateDb(join(emptyRoot, ".pi", "parallel-agents", "state.sqlite"));
  try {
    initializeState(emptyDb);
  } finally {
    emptyDb.close();
  }

  await agentsSummaryCommand("", { ...ctx, cwd: emptyRoot });
  assert.equal(notifications.at(-1).message, "No parallel agents for this repo.");
});
