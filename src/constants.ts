export const EXTENSION_NAME = "parallel-agents";
export const WIDGET_KEY = "parallel-agents";

export const RUNTIME_DIR = [".pi", "parallel-agents"] as const;
export const STATE_DB_FILE = "state.sqlite";
export const TASKS_DB_FILE = "tasks.sqlite";

export const DEFAULT_MODEL = "gpt-5.5";
export const DEFAULT_THINKING = "high";

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export const SUB_AGENT_CONTROL_TOOLS = ["start_agent", "get_parallel_agents", "message_parallel_agent", "reply_parallel_question", "control_parallel_agent"] as const;
export const READ_ONLY_SAFE_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;
export const MUTATING_BUILTIN_TOOLS = ["bash", "edit", "write"] as const;

export type ThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];
