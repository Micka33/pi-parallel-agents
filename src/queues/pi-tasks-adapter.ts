import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PiTasks } from "@micka33/pi-tasks";
import type { QueueDirection, QueueMode, QueueQuestionRow, QueueStatus } from "../state/types.js";

const MIRROR_OWNER_AGENT_ID = "pi-parallel-agents";

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

      const question = this.mustGetQuestion(db, input.questionId);
      mirrorQuestionToPiTasks(this.dbPath, questionToTaskInput(question));
      return question;
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
      if (question) mirrorQuestionToPiTasks(this.dbPath, questionToTaskInput(question));
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
      if (question) mirrorQuestionToPiTasks(this.dbPath, questionToTaskInput(question));
      return question;
    } finally {
      db.close();
    }
  }

  requeueQuestion(questionId: string): QueueQuestionRow | undefined {
    const db = this.open();
    try {
      const timestamp = nowIso();
      db.prepare("UPDATE parallel_questions SET status = 'queued', response = NULL, delivered_at = NULL, answered_at = NULL, updated_at = ? WHERE question_id = ?").run(
        timestamp,
        questionId,
      );
      const question = this.getQuestionInDb(db, questionId);
      if (question) mirrorQuestionToPiTasks(this.dbPath, questionToTaskInput(question));
      return question;
    } finally {
      db.close();
    }
  }

  private open(): DatabaseSync {
    ensurePiTasksSchema(this.dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    migrateQueueTables(db);
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

function ensurePiTasksSchema(dbPath: string): void {
  const tasks = new PiTasks({ dbPath, agentId: MIRROR_OWNER_AGENT_ID, source: "unknown" });
  tasks.close();
}

function migrateQueueTables(db: DatabaseSync): void {
  ensureParallelQuestionsTable(db);
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_parallel_questions_agent_status ON parallel_questions(agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_parallel_questions_direction ON parallel_questions(direction, created_at);
`);
}

function ensureParallelQuestionsTable(db: DatabaseSync): void {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'parallel_questions'").get() as { sql?: string } | undefined;
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

function createParallelQuestionsTable(db: DatabaseSync, tableName: string): void {
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

interface PiTaskInput {
  questionId: string;
  agentId: string;
  direction: QueueDirection;
  mode: QueueMode;
  status: QueueStatus;
  message: string;
  response: string | null;
  metadataJson: string | null;
}

type MirroredTaskStatus = "todo" | "blocked" | "done" | "canceled";

function mirrorQuestionToPiTasks(dbPath: string, input: PiTaskInput): void {
  const tasks = new PiTasks({ dbPath, agentId: MIRROR_OWNER_AGENT_ID, source: "unknown" });
  try {
    const listId = listIdForAgent(input.agentId);
    const assignedAgentId = `parallel-child:${input.agentId}`;
    const taskStatus = taskStatusForQueueStatus(input.status);
    const outcome = outcomeForTaskStatus(taskStatus, input);

    const list = tasks.ensureTaskList({
      id: listId,
      name: `parallel questions: ${input.agentId}`,
      scope_type: "agent",
      scope_key: input.agentId,
      visibility: "shared",
      owner_agent_id: input.agentId,
      update_existing: true,
    });

    tasks.upsertTask(
      {
        id: input.questionId,
        list_id: list.id,
        title: `[${input.direction}/${input.mode}] ${truncate(input.message, 160)}`,
        description: input.message,
        notes: JSON.stringify({
          parallelQuestionId: input.questionId,
          direction: input.direction,
          mode: input.mode,
          status: input.status,
          response: input.response,
          metadata: parseMetadata(input.metadataJson),
        }),
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

function taskStatusForQueueStatus(status: QueueStatus): MirroredTaskStatus {
  if (status === "answered" || status === "done") return "done";
  if (status === "blocked") return "blocked";
  if (status === "canceled") return "canceled";
  return "todo";
}

function outcomeForTaskStatus(status: MirroredTaskStatus, input: PiTaskInput): string | null {
  if (status !== "done" && status !== "canceled") return null;
  return input.response?.trim() ? input.response : `parallel question ${input.status}`;
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
