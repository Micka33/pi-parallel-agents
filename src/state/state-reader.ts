import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AgentCommandRow, AgentEventRow, AgentStateRow, ParallelAgentSettings } from "./types.js";

export interface ReadAgentsOptions {
  agentId?: string;
  repoRoot?: string;
  includeEvents?: boolean;
  eventLimit?: number;
}

export class StateReader {
  #dbPath: string;

  constructor(dbPath: string) {
    this.#dbPath = dbPath;
  }

  exists(): boolean {
    return existsSync(this.#dbPath);
  }

  readAgents(options: ReadAgentsOptions = {}): AgentStateRow[] {
    if (!this.exists()) return [];
    const db = this.#open();
    try {
      if (options.agentId) {
        const row = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(options.agentId) as AgentStateRow | undefined;
        return row ? [row] : [];
      }
      if (options.repoRoot) {
        return db.prepare("SELECT * FROM agents WHERE repo_root = ? ORDER BY created_at ASC").all(options.repoRoot) as unknown as AgentStateRow[];
      }
      return db.prepare("SELECT * FROM agents ORDER BY created_at ASC").all() as unknown as AgentStateRow[];
    } finally {
      db.close();
    }
  }

  readCommands(agentId: string, limit = 50): AgentCommandRow[] {
    if (!this.exists()) return [];
    const db = this.#open();
    try {
      return (db
        .prepare("SELECT * FROM agent_commands WHERE agent_id = ? ORDER BY id DESC LIMIT ?")
        .all(agentId, limit) as unknown as AgentCommandRow[])
        .reverse();
    } finally {
      db.close();
    }
  }

  readEvents(agentId: string, limit = 50): AgentEventRow[] {
    if (!this.exists()) return [];
    const db = this.#open();
    try {
      return (db
        .prepare("SELECT * FROM agent_events WHERE agent_id = ? ORDER BY id DESC LIMIT ?")
        .all(agentId, limit) as unknown as AgentEventRow[])
        .reverse();
    } finally {
      db.close();
    }
  }

  readSettings(): ParallelAgentSettings {
    if (!this.exists()) return {};
    const db = this.#open();
    try {
      const rows = db.prepare("SELECT key, value_json FROM settings").all() as Array<{ key: string; value_json: string }>;
      const settings: ParallelAgentSettings = {};
      for (const row of rows) {
        try {
          settings[row.key] = JSON.parse(row.value_json) as unknown;
        } catch {
          settings[row.key] = row.value_json;
        }
      }
      return settings;
    } finally {
      db.close();
    }
  }

  #open(): DatabaseSync {
    const db = new DatabaseSync(this.#dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  }
}
