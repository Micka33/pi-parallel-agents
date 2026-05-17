import type { AccessMode, WorkspaceMode } from "../constants.js";
import type { ParallelAgentDefaults } from "./defaults.js";

export interface LaunchAgentSpec {
  name: string;
  prompt: string;
  workspaceMode?: WorkspaceMode;
  accessMode?: AccessMode;
  provider?: string;
  model?: string;
  thinking?: string;
}

export interface LaunchDefaultsInput {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinking?: string;
}

export interface ParentModelDefaults {
  provider?: string;
  model?: string;
}

export interface ResolvedAgentOptions {
  name: string;
  prompt: string;
  workspaceMode: WorkspaceMode;
  accessMode: AccessMode;
  provider?: string;
  model: string;
  thinking: string;
}

export function resolveAgentOptions(
  spec: LaunchAgentSpec,
  launch: LaunchDefaultsInput,
  configuredDefaults: ParallelAgentDefaults,
  parentModel: ParentModelDefaults = {},
): ResolvedAgentOptions {
  const workspaceMode = spec.workspaceMode ?? "worktree";
  if (workspaceMode !== "worktree" && workspaceMode !== "current") {
    throw new Error(`Invalid workspaceMode for ${spec.name}: ${workspaceMode}`);
  }

  const accessMode = spec.accessMode ?? (workspaceMode === "current" ? "read_only" : "write");
  if (accessMode !== "read_only" && accessMode !== "write") {
    throw new Error(`Invalid accessMode for ${spec.name}: ${accessMode}`);
  }
  if (workspaceMode === "current" && accessMode === "write") {
    throw new Error(`current/write is blocked by parallel-agents guardrails for agent ${spec.name}; use a worktree or read_only.`);
  }

  const provider = spec.provider ?? launch.defaultProvider ?? parentModel.provider;

  return {
    name: spec.name,
    prompt: spec.prompt,
    workspaceMode,
    accessMode,
    ...(provider ? { provider } : {}),
    model: spec.model ?? launch.defaultModel ?? parentModel.model ?? configuredDefaults.model,
    thinking: spec.thinking ?? launch.defaultThinking ?? configuredDefaults.thinking,
  };
}
