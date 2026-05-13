CREATE TABLE IF NOT EXISTS agent_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivering', 'succeeded', 'failed', 'canceled')),
  response_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_commands_agent_status_id ON agent_commands(agent_id, status, id);
CREATE INDEX IF NOT EXISTS idx_agent_commands_created_at ON agent_commands(created_at);

PRAGMA user_version = 2;
