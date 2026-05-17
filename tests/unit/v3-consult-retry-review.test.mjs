import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { initializeState, openStateDb, upsertAgent } from "../../scripts/lib/state-db.mjs";
import { createQuestion, openQueueDb } from "../../scripts/lib/queue-db.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const fakePi = join(root, "tests", "fixtures", "fake-pi-rpc.mjs");
const skipUnderCoverage = process.env.PI_PARALLEL_AGENTS_COVERAGE === "1"
  ? { skip: "child-process integration imports broad extension modules; covered by npm test, skipped for strict imported-module coverage" }
  : {};

function createRepo() {
  const parent = mkdtempSync(join(tmpdir(), "pa-v3-"));
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

function tasksDb(repo) {
  return join(repo, ".pi", "parallel-agents", "tasks.sqlite");
}

function insertAgent({ repo, parent, agentId = "agent", workspaceMode = "worktree", accessMode, status = "waiting", summary = null, diffSummary = null }) {
  const worktree = workspaceMode === "worktree" ? join(parent, "pi", agentId) : repo;
  if (workspaceMode === "worktree") {
    mkdirSync(join(parent, "pi"), { recursive: true });
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", agentId, worktree, "HEAD"], { stdio: "ignore" });
  }
  const sessionFile = join(parent, `${agentId}-session.jsonl`);
  writeFileSync(sessionFile, JSON.stringify({ sessionId: `${agentId}-session` }) + "\n");
  const db = openStateDb(stateDb(repo));
  try {
    initializeState(db);
    upsertAgent(db, {
      agent_id: agentId,
      parent_session_id: "parent",
      display_name: agentId,
      repo_root: repo,
      status,
      workspace_mode: workspaceMode,
      access_mode: accessMode ?? (workspaceMode === "worktree" ? "write" : "read_only"),
      pid: null,
      cwd: worktree,
      worktree_path: workspaceMode === "worktree" ? worktree : null,
      branch_name: workspaceMode === "worktree" ? agentId : null,
      provider: "fake",
      model: "fake-model",
      thinking: "high",
      session_id: `${agentId}-session`,
      session_file: sessionFile,
      summary,
      diff_summary: diffSummary,
      tests_json: summary ? JSON.stringify({ ok: true }) : null,
    });
  } finally {
    db.close();
  }
}

function queueQuestion(repo, input) {
  const db = openQueueDb(tasksDb(repo));
  try {
    return createQuestion(db, input);
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

function childEnv(env = {}) {
  // Keep the parent coverage gate focused on modules imported by the test
  // process. These child processes are integration probes for the built
  // extension surface and would otherwise drag broad command/tool graphs into
  // V8 coverage accounting, so do not inherit Node's test-coverage env.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    ...env,
  };
}

function runNode(code, env = {}) {
  return execFileSync(process.execPath, ["--input-type=module"], {
    input: code,
    encoding: "utf8",
    env: childEnv(env),
    cwd: root,
  });
}

function runNodeResult(code, env = {}) {
  return spawnSync(process.execPath, ["--input-type=module"], {
    input: code,
    encoding: "utf8",
    env: childEnv(env),
    cwd: root,
  });
}

function distUrl(path) {
  return pathToFileURL(join(root, "dist", "src", ...path)).href;
}

test("retryBlockedQuestion requeues blocked outgoing messages and enqueues delivery", skipUnderCoverage, () => {
  const { parent, repo } = createRepo();
  insertAgent({ repo, parent, agentId: "retry-agent" });
  queueQuestion(repo, {
    questionId: "blocked-q",
    agentId: "retry-agent",
    direction: "outgoing",
    mode: "queue",
    status: "blocked",
    message: "please retry",
    response: "previous error",
  });

  const output = JSON.parse(
    runNode(`
      import { retryBlockedQuestion } from ${JSON.stringify(distUrl(["queues", "retry-question.js"]))};
      const result = await retryBlockedQuestion(${JSON.stringify(repo)}, "retry-agent", "blocked-q");
      console.log(JSON.stringify(result));
    `),
  );
  assert.equal(output.ok, true);
  assert.equal(output.question.status, "queued");
  assert.equal(output.command.command_type, "follow_up");

  const question = readRow(tasksDb(repo), "SELECT status, response FROM parallel_questions WHERE question_id = ?", "blocked-q");
  assert.equal(question.status, "queued");
  assert.equal(question.response, null);
  const command = readRow(stateDb(repo), "SELECT command_type, status FROM agent_commands WHERE id = ?", output.command.id);
  assert.equal(command.command_type, "follow_up");
  assert.equal(command.status, "queued");

  const retryAgain = runNodeResult(`
    import { retryBlockedQuestion } from ${JSON.stringify(distUrl(["queues", "retry-question.js"]))};
    await retryBlockedQuestion(${JSON.stringify(repo)}, "retry-agent", "blocked-q");
  `);
  assert.notEqual(retryAgain.status, 0);
  assert.match(retryAgain.stderr, /Only blocked questions/);
});

test("review and overlay surface blocked questions, guardrails, and recommendations", skipUnderCoverage, () => {
  const { parent, repo } = createRepo();
  insertAgent({ repo, parent, agentId: "done-agent", summary: "implemented", diffSummary: "changed files" });
  insertAgent({ repo, parent, agentId: "current-agent", workspaceMode: "current", accessMode: "write", status: "waiting" });
  queueQuestion(repo, { questionId: "blocked-review", agentId: "done-agent", direction: "outgoing", mode: "queue", status: "blocked", message: "retry me" });
  queueQuestion(repo, { questionId: "incoming-review", agentId: "current-agent", direction: "incoming", mode: "reply", status: "queued", message: "answer me" });

  const output = JSON.parse(
    runNode(`
      import { buildResultsReview } from ${JSON.stringify(distUrl(["review", "results-review.js"]))};
      import { renderAgentsOverlay } from ${JSON.stringify(distUrl(["tui", "overlay.js"]))};
      const review = buildResultsReview(${JSON.stringify(repo)});
      const overlayAgents = review.agents.map((agent) => ({
        agentId: agent.agentId,
        displayName: agent.displayName,
        parentSessionId: "parent",
        repoRoot: ${JSON.stringify(repo)},
        status: agent.status,
        workspaceMode: agent.workspaceMode,
        accessMode: agent.accessMode,
        pid: null,
        cwd: ${JSON.stringify(repo)},
        worktreePath: null,
        branchName: null,
        provider: "fake",
        model: "fake-model",
        thinking: "high",
        sessionId: null,
        sessionFile: null,
        summary: agent.summary,
        diffSummary: agent.diffSummary,
        testsJson: agent.testsJson,
        lastError: agent.lastError,
        createdAt: "now",
        updatedAt: "now",
        queue: review.blockedQuestions.filter((question) => question.agent_id === agent.agentId),
      }));
      overlayAgents.find((agent) => agent.agentId === "current-agent").queue.push({ question_id: "incoming-review", agent_id: "current-agent", direction: "incoming", mode: "reply", status: "queued", message: "answer me", response: null });
      const overlay = renderAgentsOverlay(overlayAgents, ${JSON.stringify(repo)});
      console.log(JSON.stringify({ review, overlay }));
    `),
  );

  assert.equal(output.review.count, 2);
  assert.equal(output.review.statusCounts.waiting, 2);
  assert.match(output.review.markdown, /Blocked questions/);
  assert.match(output.review.markdown, /blocked-review/);
  assert.ok(output.review.recommendations.some((item) => item.includes("Retry or cancel")));
  assert.ok(output.review.recommendations.some((item) => item.includes("current\/write")));
  assert.match(output.overlay, /agents-consult/);
  assert.match(output.overlay, /Blocked questions/);
  assert.match(output.overlay, /current-agent: current\/write shares the parent checkout/);
});

test("slash commands wrap consult, retry, and review behavior", skipUnderCoverage, () => {
  const { parent, repo } = createRepo();
  insertAgent({ repo, parent, agentId: "consult-agent" });
  insertAgent({ repo, parent, agentId: "retry-agent" });
  queueQuestion(repo, { questionId: "retry-from-command", agentId: "retry-agent", direction: "outgoing", mode: "steer", status: "blocked", message: "steer again" });

  const output = JSON.parse(
    runNode(
      `
        import { agentsConsultCommand } from ${JSON.stringify(distUrl(["commands", "agents-consult.js"]))};
        import { agentsRetryCommand } from ${JSON.stringify(distUrl(["commands", "agents-retry.js"]))};
        import { agentsReviewCommand } from ${JSON.stringify(distUrl(["commands", "agents-review.js"]))};
        const notifications = [];
        const widgets = [];
        const ctx = {
          cwd: ${JSON.stringify(repo)},
          ui: {
            notify(message, level) { notifications.push({ message, level }); },
            setWidget(key, value) { widgets.push({ key, value }); },
          },
        };
        await agentsConsultCommand("consult-agent Can you inspect safely?", ctx);
        await agentsRetryCommand("retry-agent retry-from-command", ctx);
        await agentsReviewCommand("", ctx);
        console.log(JSON.stringify({ notifications, widgets }));
      `,
      { PI_PARALLEL_AGENTS_PI_BIN: fakePi },
    ),
  );

  assert.match(output.notifications.at(0).message, /fake done/);
  assert.match(output.notifications.at(1).message, /retry_question/);
  assert.match(output.notifications.at(2).message, /Parallel agents review/);
  const consultRow = readRow(tasksDb(repo), "SELECT mode, status, response FROM parallel_questions WHERE agent_id = ? AND mode = 'consult'", "consult-agent");
  assert.equal(consultRow.mode, "consult");
  assert.equal(consultRow.status, "answered");
  assert.equal(consultRow.response, "fake done");
  const retried = readRow(tasksDb(repo), "SELECT status FROM parallel_questions WHERE question_id = ?", "retry-from-command");
  assert.equal(retried.status, "queued");
});
