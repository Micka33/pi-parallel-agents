PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'waiting', 'stopped', 'crashed', 'done', 'cleaned')),
  workspace_mode TEXT NOT NULL CHECK (workspace_mode IN ('worktree', 'current')),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('read_only', 'write')),
  pid INTEGER,
  cwd TEXT NOT NULL,
  worktree_path TEXT,
  branch_name TEXT,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  session_id TEXT,
  session_file TEXT,
  summary TEXT,
  diff_summary TEXT,
  tests_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_repo_root ON agents(repo_root);
CREATE INDEX IF NOT EXISTS idx_agent_events_agent_created ON agent_events(agent_id, created_at);

PRAGMA user_version = 1;
