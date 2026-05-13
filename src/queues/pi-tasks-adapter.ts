import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QueueDirection, QueueMode, QueueQuestionRow, QueueStatus } from "../state/types.js";

export interface CreateQuestionInput {
  questionId: string;
  agentId: string;
  direction: QueueDirection;
  mode: QueueMode;
  status?: QueueStatus;
  message: string;
  response?: string | null;
  metadata?: unknown;
}

export interface ListQuestionsOptions {
  agentId?: string;
  direction?: QueueDirection;
  status?: QueueStatus;
  limit?: number;
}

export class PiTasksQueueAdapter {
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  init(): void {
    const db = this.open();
    db.close();
  }

  createQuestion(input: CreateQuestionInput): QueueQuestionRow {
    const db = this.open();
    try {
      const timestamp = nowIso();
      const status = input.status ?? "queued";
      const metadataJson = input.metadata === undefined ? null : JSON.stringify(input.metadata);
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
      ).run(input.questionId, input.agentId, input.direction, input.mode, status, input.message, input.response ?? null, metadataJson, timestamp, timestamp);
      upsertPiTask(db, {
        questionId: input.questionId,
        agentId: input.agentId,
        direction: input.direction,
        mode: input.mode,
        status,
        message: input.message,
        response: input.response ?? null,
        metadataJson,
        timestamp,
      });
      return this.mustGetQuestion(db, input.questionId);
    } finally {
      db.close();
    }
  }

  getQuestion(questionId: string): QueueQuestionRow | undefined {
    const db = this.open();
    try {
      return (db.prepare("SELECT * FROM parallel_questions WHERE question_id = ?").get(questionId) as QueueQuestionRow | undefined) ?? undefined;
    } finally {
      db.close();
    }
  }

  listQuestions(options: ListQuestionsOptions = {}): QueueQuestionRow[] {
    const db = this.open();
    try {
      const where: string[] = [];
      const args: Array<string | number> = [];
      if (options.agentId) {
        where.push("agent_id = ?");
        args.push(options.agentId);
      }
      if (options.direction) {
        where.push("direction = ?");
        args.push(options.direction);
      }
      if (options.status) {
        where.push("status = ?");
        args.push(options.status);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return db
        .prepare(`SELECT * FROM parallel_questions ${clause} ORDER BY created_at ASC LIMIT ?`)
        .all(...args, options.limit ?? 50) as unknown as QueueQuestionRow[];
    } finally {
      db.close();
    }
  }

  markDelivered(questionId: string): QueueQuestionRow | undefined {
    const db = this.open();
    try {
      const timestamp = nowIso();
      db.prepare("UPDATE parallel_questions SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE question_id = ?").run(
        timestamp,
        timestamp,
        questionId,
      );
      const question = this.getQuestionInDb(db, questionId);
      if (question) upsertPiTask(db, { ...questionToTaskInput(question), timestamp });
      return question;
    } finally {
      db.close();
    }
  }

  answerQuestion(questionId: string, response: string, status: Extract<QueueStatus, "answered" | "done" | "blocked"> = "answered"): QueueQuestionRow | undefined {
    const db = this.open();
    try {
      const timestamp = nowIso();
      db.prepare("UPDATE parallel_questions SET status = ?, response = ?, answered_at = ?, updated_at = ? WHERE question_id = ?").run(
        status,
        response,
        timestamp,
        timestamp,
        questionId,
      );
      const question = this.getQuestionInDb(db, questionId);
      if (question) upsertPiTask(db, { ...questionToTaskInput(question), timestamp });
      return question;
    } finally {
      db.close();
    }
  }

  private open(): DatabaseSync {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    migrate(db);
    return db;
  }

  private getQuestionInDb(db: DatabaseSync, questionId: string): QueueQuestionRow | undefined {
    return (db.prepare("SELECT * FROM parallel_questions WHERE question_id = ?").get(questionId) as QueueQuestionRow | undefined) ?? undefined;
  }

  private mustGetQuestion(db: DatabaseSync, questionId: string): QueueQuestionRow {
    const row = this.getQuestionInDb(db, questionId);
    if (!row) throw new Error(`Question was not created: ${questionId}`);
    return row;
  }
}

function migrate(db: DatabaseSync): void {
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

interface PiTaskInput {
  questionId: string;
  agentId: string;
  direction: QueueDirection;
  mode: QueueMode;
  status: QueueStatus;
  message: string;
  response: string | null;
  metadataJson: string | null;
  timestamp?: string;
}

function upsertPiTask(db: DatabaseSync, input: PiTaskInput): void {
  const timestamp = input.timestamp ?? nowIso();
  const listId = listIdForAgent(input.agentId);
  db.prepare(
    "INSERT INTO task_lists (id, name, scope_type, scope_key, visibility, owner_agent_id, created_by_agent_id, created_at, updated_at, deleted_at) VALUES (?, ?, 'agent', ?, 'shared', ?, 'pi-parallel-agents', ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted_at = NULL",
  ).run(listId, `parallel questions: ${input.agentId}`, input.agentId, input.agentId, timestamp, timestamp);
  const existing = db.prepare("SELECT id FROM tasks WHERE id = ?").get(input.questionId);
  const position = existing ? null : nextTaskPosition(db, listId);
  const title = `[${input.direction}/${input.mode}] ${truncate(input.message, 160)}`;
  const notes = JSON.stringify({
    parallelQuestionId: input.questionId,
    direction: input.direction,
    mode: input.mode,
    status: input.status,
    response: input.response,
    metadata: parseMetadata(input.metadataJson),
  });
  const taskStatus = taskStatusForQueueStatus(input.status);
  const outcome = taskStatus === "done" ? input.response ?? `parallel question ${input.status}` : null;
  if (existing) {
    db.prepare("UPDATE tasks SET title = ?, notes = ?, status = ?, outcome = ?, updated_at = ?, completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE completed_at END WHERE id = ?").run(
      title,
      notes,
      taskStatus,
      outcome,
      timestamp,
      taskStatus,
      timestamp,
      input.questionId,
    );
    return;
  }
  db.prepare(
    "INSERT INTO tasks (id, list_id, position, title, description, notes, status, assigned_to_agent_id, claimed_by_agent_id, claim_expires_at, outcome, created_at, updated_at, started_at, completed_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, NULL)",
  ).run(
    input.questionId,
    listId,
    position,
    title,
    input.message,
    notes,
    taskStatus,
    `parallel-child:${input.agentId}`,
    outcome,
    timestamp,
    timestamp,
    taskStatus === "done" ? timestamp : null,
  );
}

function questionToTaskInput(question: QueueQuestionRow): PiTaskInput {
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

function listIdForAgent(agentId: string): string {
  return `parallel-agent-${agentId.replace(/[^a-zA-Z0-9._:-]+/g, "-")}-questions`;
}

function nextTaskPosition(db: DatabaseSync, listId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM tasks WHERE list_id = ?").get(listId) as { position?: number } | undefined;
  return Number(row?.position ?? 1);
}

function taskStatusForQueueStatus(status: QueueStatus): "todo" | "blocked" | "done" | "canceled" {
  if (status === "answered" || status === "done") return "done";
  if (status === "blocked") return "blocked";
  if (status === "canceled") return "canceled";
  return "todo";
}

function parseMetadata(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return json;
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function nowIso(): string {
  return new Date().toISOString();
}
