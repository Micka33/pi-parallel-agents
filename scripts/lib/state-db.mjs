import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const STATE_SCHEMA_VERSION = 1;
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

  if (version === 0) {
    db.exec(readFileSync(join(sqlDir, "001_state_schema.sql"), "utf8"));
    db.exec(readFileSync(join(sqlDir, "002_state_indexes.sql"), "utf8"));
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
