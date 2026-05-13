import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function nowIso() {
  return new Date().toISOString();
}

export function openQueueDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  migrateQueueDb(db);
  return db;
}

export function migrateQueueDb(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS task_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'thread', 'agent', 'global', 'custom')),
  scope_key TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'shared')),
  owner_agent_id TEXT,
  created_by_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES task_lists(id),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  notes TEXT,
  status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'canceled')),
  assigned_to_agent_id TEXT,
  claimed_by_agent_id TEXT,
  claim_expires_at TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS private_access_events (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES task_lists(id),
  actor_agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_lists_scope ON task_lists(scope_type, scope_key, visibility);
CREATE INDEX IF NOT EXISTS idx_task_lists_deleted ON task_lists(deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_list_position ON tasks(list_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(status, claim_expires_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assignment ON tasks(list_id, assigned_to_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at);
CREATE INDEX IF NOT EXISTS idx_private_access_events_list ON private_access_events(list_id, created_at);

CREATE TABLE IF NOT EXISTS parallel_questions (
  question_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  mode TEXT NOT NULL CHECK (mode IN ('steer', 'queue', 'reply')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'answered', 'done', 'blocked', 'canceled')),
  message TEXT NOT NULL,
  response TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_parallel_questions_agent_status ON parallel_questions(agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_parallel_questions_direction ON parallel_questions(direction, created_at);
`);
}

export function createQuestion(db, { questionId, agentId, direction, mode, status = "queued", message, response = null, metadataJson = null }) {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO parallel_questions
      (question_id, agent_id, direction, mode, status, message, response, metadata_json, created_at, updated_at, delivered_at, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(question_id) DO UPDATE SET
       status = excluded.status,
       message = excluded.message,
       response = COALESCE(excluded.response, parallel_questions.response),
       metadata_json = COALESCE(excluded.metadata_json, parallel_questions.metadata_json),
       updated_at = excluded.updated_at`,
  ).run(questionId, agentId, direction, mode, status, message, response, metadataJson, timestamp, timestamp);
  upsertPiTask(db, { questionId, agentId, direction, mode, status, message, response, metadataJson, timestamp });
  return getQuestion(db, questionId);
}

export function getQuestion(db, questionId) {
  return db.prepare("SELECT * FROM parallel_questions WHERE question_id = ?").get(questionId) ?? null;
}

export function listQuestions(db, { agentId, direction, status, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (agentId) {
    where.push("agent_id = ?");
    args.push(agentId);
  }
  if (direction) {
    where.push("direction = ?");
    args.push(direction);
  }
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM parallel_questions ${clause} ORDER BY created_at ASC LIMIT ?`).all(...args, limit);
}

export function markQuestionDelivered(db, questionId) {
  const timestamp = nowIso();
  db.prepare("UPDATE parallel_questions SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE question_id = ?").run(
    timestamp,
    timestamp,
    questionId,
  );
  const question = getQuestion(db, questionId);
  if (question) upsertPiTask(db, { ...questionToTaskInput(question), timestamp });
  return question;
}

export function markQuestionBlocked(db, questionId, error) {
  const existing = getQuestion(db, questionId);
  if (!existing) return null;
  const metadata = mergeMetadata(existing.metadata_json, { lastError: error });
  const timestamp = nowIso();
  db.prepare("UPDATE parallel_questions SET status = 'blocked', metadata_json = ?, updated_at = ? WHERE question_id = ?").run(
    JSON.stringify(metadata),
    timestamp,
    questionId,
  );
  const question = getQuestion(db, questionId);
  if (question) upsertPiTask(db, { ...questionToTaskInput(question), timestamp });
  return question;
}

export function answerQuestion(db, { questionId, response, status = "answered" }) {
  const timestamp = nowIso();
  db.prepare("UPDATE parallel_questions SET status = ?, response = ?, answered_at = ?, updated_at = ? WHERE question_id = ?").run(
    status,
    response,
    timestamp,
    timestamp,
    questionId,
  );
  const question = getQuestion(db, questionId);
  if (question) upsertPiTask(db, { ...questionToTaskInput(question), timestamp });
  return question;
}

function upsertPiTask(db, { questionId, agentId, direction, mode, status, message, response = null, metadataJson = null, timestamp = nowIso() }) {
  const listId = listIdForAgent(agentId);
  db.prepare(
    "INSERT INTO task_lists (id, name, scope_type, scope_key, visibility, owner_agent_id, created_by_agent_id, created_at, updated_at, deleted_at) VALUES (?, ?, 'agent', ?, 'shared', ?, 'pi-parallel-agents', ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted_at = NULL",
  ).run(listId, `parallel questions: ${agentId}`, agentId, agentId, timestamp, timestamp);
  const existing = db.prepare("SELECT id FROM tasks WHERE id = ?").get(questionId);
  const position = existing ? null : nextTaskPosition(db, listId);
  const title = `[${direction}/${mode}] ${truncate(message, 160)}`;
  const notes = JSON.stringify({ parallelQuestionId: questionId, direction, mode, status, response, metadata: parseMetadata(metadataJson) });
  const taskStatus = taskStatusForQueueStatus(status);
  const outcome = taskStatus === "done" ? response ?? `parallel question ${status}` : null;
  if (existing) {
    db.prepare("UPDATE tasks SET title = ?, notes = ?, status = ?, outcome = ?, updated_at = ?, completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE completed_at END WHERE id = ?").run(
      title,
      notes,
      taskStatus,
      outcome,
      timestamp,
      taskStatus,
      timestamp,
      questionId,
    );
  } else {
    db.prepare(
      "INSERT INTO tasks (id, list_id, position, title, description, notes, status, assigned_to_agent_id, claimed_by_agent_id, claim_expires_at, outcome, created_at, updated_at, started_at, completed_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, NULL)",
    ).run(
      questionId,
      listId,
      position,
      title,
      message,
      notes,
      taskStatus,
      `parallel-child:${agentId}`,
      outcome,
      timestamp,
      timestamp,
      taskStatus === "done" ? timestamp : null,
    );
  }
}

function questionToTaskInput(question) {
  return {
    questionId: question.question_id,
    agentId: question.agent_id,
    direction: question.direction,
    mode: question.mode,
    status: question.status,
    message: question.message,
    response: question.response,
    metadataJson: question.metadata_json,
  };
}

function listIdForAgent(agentId) {
  return `parallel-agent-${String(agentId).replace(/[^a-zA-Z0-9._:-]+/g, "-")}-questions`;
}

function nextTaskPosition(db, listId) {
  const row = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM tasks WHERE list_id = ?").get(listId);
  return Number(row?.position ?? 1);
}

function taskStatusForQueueStatus(status) {
  if (status === "answered" || status === "done") return "done";
  if (status === "blocked") return "blocked";
  if (status === "canceled") return "canceled";
  return "todo";
}

function parseMetadata(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function truncate(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function mergeMetadata(json, patch) {
  let value = {};
  if (json) {
    try {
      value = JSON.parse(json);
    } catch {}
  }
  return { ...value, ...patch };
}
