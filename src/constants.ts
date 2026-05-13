export const EXTENSION_NAME = "parallel-agents";
export const WIDGET_KEY = "parallel-agents";

export const RUNTIME_DIR = [".pi", "parallel-agents"] as const;
export const STATE_DB_FILE = "state.sqlite";
export const TASKS_DB_FILE = "tasks.sqlite";

export const DEFAULT_MODEL = "gpt-5.5";
export const DEFAULT_THINKING = "high";

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const VALID_WORKSPACE_MODES = ["worktree", "current"] as const;
export const VALID_ACCESS_MODES = ["read_only", "write"] as const;

export type ThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];
export type WorkspaceMode = (typeof VALID_WORKSPACE_MODES)[number];
export type AccessMode = (typeof VALID_ACCESS_MODES)[number];
