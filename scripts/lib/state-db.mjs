import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const STATE_SCHEMA_VERSION = 2;
export const DEFAULT_MODEL = "gpt-5.5";
export const DEFAULT_THINKING = "high";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(__dirname, "..", "sql");

export const AGENT_COLUMNS = [
  "agent_id",
  "parent_session_id",
  "display_name",
  "repo_root",
  "status",
  "workspace_mode",
  "access_mode",
  "pid",
  "cwd",
  "worktree_path",
  "branch_name",
  "provider",
  "model",
  "thinking",
  "session_id",
  "session_file",
  "summary",
  "diff_summary",
  "tests_json",
  "last_error",
  "created_at",
  "updated_at",
];

export const COMMAND_COLUMNS = [
  "id",
  "agent_id",
  "command_type",
  "payload_json",
  "status",
  "response_json",
  "last_error",
  "created_at",
  "updated_at",
  "delivered_at",
  "completed_at",
];

const REQUIRED_AGENT_FIELDS = [
  "agent_id",
  "parent_session_id",
  "display_name",
  "repo_root",
  "status",
  "workspace_mode",
  "access_mode",
  "cwd",
];

export function nowIso() {
  return new Date().toISOString();
}

export function openStateDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

export function migrate(db) {
  const version = db.prepare("PRAGMA user_version").get()?.user_version ?? 0;
  if (version > STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported parallel-agents state schema version ${version}; this package supports ${STATE_SCHEMA_VERSION}`);
  }

  let currentVersion = version;
  if (currentVersion === 0) {
    db.exec(readFileSync(join(sqlDir, "001_state_schema.sql"), "utf8"));
    db.exec(readFileSync(join(sqlDir, "002_state_indexes.sql"), "utf8"));
    currentVersion = 1;
  }
  if (currentVersion < 2) {
    db.exec(readFileSync(join(sqlDir, "003_state_v2.sql"), "utf8"));
    currentVersion = 2;
  }
}

export function initializeState(db) {
  const timestamp = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    setSettingRaw(db, "default_model", DEFAULT_MODEL, timestamp, false);
    setSettingRaw(db, "default_thinking", DEFAULT_THINKING, timestamp, false);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function getAgent(db, agentId) {
  return db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) ?? null;
}

export function listAgents(db, { repoRoot, agentId } = {}) {
  if (agentId) {
    const agent = getAgent(db, agentId);
    return agent ? [agent] : [];
  }
  if (repoRoot) {
    return db.prepare("SELECT * FROM agents WHERE repo_root = ? ORDER BY created_at ASC").all(repoRoot);
  }
  return db.prepare("SELECT * FROM agents ORDER BY created_at ASC").all();
}

export function upsertAgent(db, fields) {
  return withImmediateTransaction(db, () => {
    const normalizedFields = normalizeAgentFields(fields);
    const timestamp = nowIso();
    const existing = normalizedFields.agent_id ? getAgent(db, normalizedFields.agent_id) : null;
    const merged = {
      ...(existing ?? {}),
      ...normalizedFields,
      created_at: existing?.created_at ?? normalizedFields.created_at ?? timestamp,
      updated_at: timestamp,
    };

    for (const key of REQUIRED_AGENT_FIELDS) {
      if (merged[key] === undefined || merged[key] === null || merged[key] === "") {
        throw new Error(`Missing required agent field: ${key}`);
      }
    }

    for (const key of AGENT_COLUMNS) {
      if (!(key in merged)) merged[key] = null;
    }

    const placeholders = AGENT_COLUMNS.map(() => "?").join(", ");
    const updateClause = AGENT_COLUMNS.filter((column) => column !== "agent_id" && column !== "created_at")
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");
    const sql = `INSERT INTO agents (${AGENT_COLUMNS.join(", ")}) VALUES (${placeholders}) ON CONFLICT(agent_id) DO UPDATE SET ${updateClause}`;
    db.prepare(sql).run(...AGENT_COLUMNS.map((column) => merged[column]));
    return getAgent(db, merged.agent_id);
  });
}

export function setAgentStatus(db, { agentId, status, pid, lastError }) {
  const existing = getAgent(db, agentId);
  if (!existing) throw new Error(`Unknown agent: ${agentId}`);
  const fields = { agent_id: agentId, status };
  if (Object.prototype.hasOwnProperty.call(arguments[1], "pid")) fields.pid = pid;
  if (lastError !== undefined) fields.last_error = lastError;
  return upsertAgent(db, fields);
}

export function setAgentResult(db, { agentId, summary, diffSummary, testsJson, status }) {
  const existing = getAgent(db, agentId);
  if (!existing) throw new Error(`Unknown agent: ${agentId}`);
  return upsertAgent(db, {
    agent_id: agentId,
    status: status ?? existing.status,
    summary: summary ?? existing.summary,
    diff_summary: diffSummary ?? existing.diff_summary,
    tests_json: testsJson ?? existing.tests_json,
  });
}

export function appendEvent(db, { agentId, eventType, payloadJson }) {
  const timestamp = nowIso();
  db.prepare("INSERT INTO agent_events (agent_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(
    agentId,
    eventType,
    payloadJson ?? null,
    timestamp,
  );
  return { agent_id: agentId, event_type: eventType, payload_json: payloadJson ?? null, created_at: timestamp };
}

export function listEvents(db, { agentId, limit = 50 } = {}) {
  if (agentId) {
    return db
      .prepare("SELECT * FROM agent_events WHERE agent_id = ? ORDER BY id DESC LIMIT ?")
      .all(agentId, limit)
      .reverse();
  }
  return db.prepare("SELECT * FROM agent_events ORDER BY id DESC LIMIT ?").all(limit).reverse();
}

export function setDefaults(db, { model, thinking }) {
  const timestamp = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (model !== undefined) setSettingRaw(db, "default_model", model, timestamp, true);
    if (thinking !== undefined) setSettingRaw(db, "default_thinking", thinking, timestamp, true);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function enqueueAgentCommand(db, { agentId, commandType, payloadJson }) {
  const existing = getAgent(db, agentId);
  if (!existing) throw new Error(`Unknown agent: ${agentId}`);
  const timestamp = nowIso();
  const payload = normalizeJsonValue(payloadJson ?? {});
  return withImmediateTransaction(db, () => {
    const result = db
      .prepare(
        "INSERT INTO agent_commands (agent_id, command_type, payload_json, status, response_json, last_error, created_at, updated_at, delivered_at, completed_at) VALUES (?, ?, ?, 'queued', NULL, NULL, ?, ?, NULL, NULL)",
      )
      .run(agentId, commandType, payload, timestamp, timestamp);
    appendEvent(db, {
      agentId,
      eventType: "command_queued",
      payloadJson: JSON.stringify({ commandId: Number(result.lastInsertRowid), commandType, payload: JSON.parse(payload) }),
    });
    return getAgentCommand(db, Number(result.lastInsertRowid));
  });
}

export function getAgentCommand(db, commandId) {
  return db.prepare("SELECT * FROM agent_commands WHERE id = ?").get(commandId) ?? null;
}

export function listAgentCommands(db, { agentId, status, limit = 50 } = {}) {
  if (agentId && status) {
    return db.prepare("SELECT * FROM agent_commands WHERE agent_id = ? AND status = ? ORDER BY id ASC LIMIT ?").all(agentId, status, limit);
  }
  if (agentId) {
    return db.prepare("SELECT * FROM agent_commands WHERE agent_id = ? ORDER BY id DESC LIMIT ?").all(agentId, limit).reverse();
  }
  return db.prepare("SELECT * FROM agent_commands ORDER BY id DESC LIMIT ?").all(limit).reverse();
}

export function claimQueuedAgentCommands(db, { agentId, limit = 10 }) {
  const timestamp = nowIso();
  return withImmediateTransaction(db, () => {
    const rows = db
      .prepare("SELECT * FROM agent_commands WHERE agent_id = ? AND status = 'queued' ORDER BY id ASC LIMIT ?")
      .all(agentId, limit);
    for (const row of rows) {
      db.prepare("UPDATE agent_commands SET status = 'delivering', updated_at = ?, delivered_at = ? WHERE id = ? AND status = 'queued'").run(
        timestamp,
        timestamp,
        row.id,
      );
      row.status = "delivering";
      row.updated_at = timestamp;
      row.delivered_at = timestamp;
    }
    return rows;
  });
}

export function completeAgentCommand(db, { commandId, status, responseJson, lastError }) {
  if (status !== "succeeded" && status !== "failed" && status !== "canceled") throw new Error(`Invalid command completion status: ${status}`);
  const existing = getAgentCommand(db, commandId);
  if (!existing) throw new Error(`Unknown agent command: ${commandId}`);
  const timestamp = nowIso();
  return withImmediateTransaction(db, () => {
    db.prepare(
      "UPDATE agent_commands SET status = ?, response_json = ?, last_error = ?, updated_at = ?, completed_at = ? WHERE id = ?",
    ).run(status, responseJson === undefined ? existing.response_json : normalizeJsonValue(responseJson), lastError ?? null, timestamp, timestamp, commandId);
    appendEvent(db, {
      agentId: existing.agent_id,
      eventType: status === "succeeded" ? "command_succeeded" : "command_failed",
      payloadJson: JSON.stringify({ commandId, commandType: existing.command_type, status, lastError: lastError ?? null }),
    });
    return getAgentCommand(db, commandId);
  });
}

export function getSettings(db) {
  const rows = db.prepare("SELECT key, value_json, updated_at FROM settings").all();
  const settings = {};
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value_json);
    } catch {
      settings[row.key] = row.value_json;
    }
  }
  return settings;
}

function normalizeJsonValue(value) {
  if (typeof value === "string") {
    JSON.parse(value);
    return value;
  }
  return JSON.stringify(value ?? {});
}

function setSettingRaw(db, key, value, timestamp, overwrite) {
  if (!overwrite) {
    const existing = db.prepare("SELECT key FROM settings WHERE key = ?").get(key);
    if (existing) return;
  }
  db.prepare(
    "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
  ).run(key, JSON.stringify(value), timestamp);
}

function normalizeAgentFields(fields) {
  const normalized = { ...fields };
  const aliasMap = {
    agentId: "agent_id",
    parentSessionId: "parent_session_id",
    displayName: "display_name",
    repoRoot: "repo_root",
    workspaceMode: "workspace_mode",
    accessMode: "access_mode",
    worktreePath: "worktree_path",
    branchName: "branch_name",
    sessionId: "session_id",
    sessionFile: "session_file",
    diffSummary: "diff_summary",
    testsJson: "tests_json",
    lastError: "last_error",
  };
  for (const [from, to] of Object.entries(aliasMap)) {
    if (Object.prototype.hasOwnProperty.call(normalized, from) && !Object.prototype.hasOwnProperty.call(normalized, to)) {
      normalized[to] = normalized[from];
      delete normalized[from];
    }
  }
  return normalized;
}

export function withImmediateTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
