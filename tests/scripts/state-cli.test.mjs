import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..", "..");
const stateScript = join(root, "scripts", "parallel-agent-state.sh");

test("parallel-agent-state.sh initializes schema and writes agent state", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-state-"));
  const dbPath = join(dir, "state.sqlite");
  const init = JSON.parse(execFileSync(stateScript, ["init", "--state-db", dbPath], { encoding: "utf8" }));
  assert.equal(init.ok, true);
  assert.equal(init.settings.default_model, "gpt-5.5");
  assert.equal(init.settings.default_thinking, "high");

  const agentJson = join(dir, "agent.json");
  writeFileSync(
    agentJson,
    JSON.stringify({
      agent_id: "api",
      parent_session_id: "parent",
      display_name: "api",
      repo_root: dir,
      status: "starting",
      workspace_mode: "current",
      access_mode: "read_only",
      cwd: dir,
      model: "gpt-5.5",
      thinking: "high",
    }),
  );

  const upsert = JSON.parse(execFileSync(stateScript, ["upsert-agent", "--state-db", dbPath, "--agent-json", agentJson], { encoding: "utf8" }));
  assert.equal(upsert.agent.agent_id, "api");
  assert.equal(upsert.agent.status, "starting");

  const status = JSON.parse(
    execFileSync(stateScript, ["set-status", "--state-db", dbPath, "--agent-id", "api", "--status", "running", "--pid", "123"], {
      encoding: "utf8",
    }),
  );
  assert.equal(status.agent.status, "running");
  assert.equal(status.agent.pid, 123);

  execFileSync(stateScript, ["append-event", "--state-db", dbPath, "--agent-id", "api", "--event-type", "test", "--payload-json", "{\"ok\":true}"], {
    encoding: "utf8",
  });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get("api");
    assert.equal(row.status, "running");
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM agent_events WHERE agent_id = ?").get("api").count;
    assert.equal(eventCount, 1);
  } finally {
    db.close();
  }
});
