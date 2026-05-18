import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PiTasks } from "@micka33/pi-tasks";

const MIRROR_OWNER_AGENT_ID = "pi-parallel-agents";
const dbPaths = new WeakMap();

export function nowIso() {
  return new Date().toISOString();
}

export function openQueueDb(dbPath) {
  ensurePiTasksSchema(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  dbPaths.set(db, dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  migrateQueueDb(db);
  return db;
}

export function migrateQueueDb(db) {
  ensureParallelQuestionsTable(db);
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_parallel_questions_agent_status ON parallel_questions(agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_parallel_questions_direction ON parallel_questions(direction, created_at);
`);
}

function ensureParallelQuestionsTable(db) {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'parallel_questions'").get();
  if (!existing) {
    createParallelQuestionsTable(db, "parallel_questions");
    return;
  }
  if (String(existing.sql ?? "").includes("mode IN ('steer', 'queue', 'reply')")) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP INDEX IF EXISTS idx_parallel_questions_agent_status");
    db.exec("DROP INDEX IF EXISTS idx_parallel_questions_direction");
    createParallelQuestionsTable(db, "parallel_questions_rebuilt");
    db.exec(`
INSERT INTO parallel_questions_rebuilt
  (question_id, agent_id, direction, mode, status, message, response, metadata_json, created_at, updated_at, delivered_at, answered_at)
SELECT question_id, agent_id, direction, CASE WHEN mode IN ('steer', 'queue', 'reply') THEN mode ELSE 'queue' END, status, message, response, metadata_json, created_at, updated_at, delivered_at, answered_at
FROM parallel_questions;
DROP TABLE parallel_questions;
ALTER TABLE parallel_questions_rebuilt RENAME TO parallel_questions;
`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function createParallelQuestionsTable(db, tableName) {
  db.exec(`
CREATE TABLE ${tableName} (
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
  const question = getQuestion(db, questionId);
  if (question) mirrorQuestionToPiTasks(dbPathFor(db), questionToTaskInput(question));
  return question;
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
  if (question) mirrorQuestionToPiTasks(dbPathFor(db), questionToTaskInput(question));
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
  if (question) mirrorQuestionToPiTasks(dbPathFor(db), questionToTaskInput(question));
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
  if (question) mirrorQuestionToPiTasks(dbPathFor(db), questionToTaskInput(question));
  return question;
}

export function requeueQuestion(db, questionId) {
  const timestamp = nowIso();
  db.prepare("UPDATE parallel_questions SET status = 'queued', response = NULL, delivered_at = NULL, answered_at = NULL, updated_at = ? WHERE question_id = ?").run(
    timestamp,
    questionId,
  );
  const question = getQuestion(db, questionId);
  if (question) mirrorQuestionToPiTasks(dbPathFor(db), questionToTaskInput(question));
  return question;
}

function ensurePiTasksSchema(dbPath) {
  const tasks = new PiTasks({ dbPath, agentId: MIRROR_OWNER_AGENT_ID, source: "unknown" });
  tasks.close();
}

function mirrorQuestionToPiTasks(dbPath, { questionId, agentId, direction, mode, status, message, response = null, metadataJson = null }) {
  const tasks = new PiTasks({ dbPath, agentId: MIRROR_OWNER_AGENT_ID, source: "unknown" });
  try {
    const listId = listIdForAgent(agentId);
    const assignedAgentId = `parallel-child:${agentId}`;
    const taskStatus = taskStatusForQueueStatus(status);
    const outcome = outcomeForTaskStatus(taskStatus, { status, response });

    const list = tasks.ensureTaskList({
      id: listId,
      name: `parallel questions: ${agentId}`,
      scope_type: "agent",
      scope_key: agentId,
      visibility: "shared",
      owner_agent_id: agentId,
      update_existing: true,
    });

    tasks.upsertTask(
      {
        id: questionId,
        list_id: list.id,
        title: `[${direction}/${mode}] ${truncate(message, 160)}`,
        description: message,
        notes: JSON.stringify({ parallelQuestionId: questionId, direction, mode, status, response, metadata: parseMetadata(metadataJson) }),
        status: taskStatus,
        assigned_to_agent_id: assignedAgentId,
        outcome,
      },
      { agentId: assignedAgentId, source: "unknown" },
    );
  } finally {
    tasks.close();
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

function taskStatusForQueueStatus(status) {
  if (status === "answered" || status === "done") return "done";
  if (status === "blocked") return "blocked";
  if (status === "canceled") return "canceled";
  return "todo";
}

function outcomeForTaskStatus(taskStatus, { status, response }) {
  if (taskStatus !== "done" && taskStatus !== "canceled") return null;
  return response?.trim() ? response : `parallel question ${status}`;
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

function dbPathFor(db) {
  const mapped = dbPaths.get(db);
  if (mapped) return mapped;
  const main = db.prepare("PRAGMA database_list").all().find((row) => row.name === "main");
  if (typeof main?.file === "string" && main.file) return main.file;
  throw new Error("Queue database has no filesystem path for pi-tasks mirroring");
}
