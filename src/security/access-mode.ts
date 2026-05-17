import type { AccessMode, WorkspaceMode } from "../constants.js";

export function defaultAccessMode(workspaceMode: WorkspaceMode): AccessMode {
  return workspaceMode === "current" ? "read_only" : "write";
}

export function assertAccessModeAllowed(workspaceMode: WorkspaceMode, accessMode: AccessMode): void {
  if (workspaceMode === "current" && accessMode === "write") {
    throw new Error("current/write is blocked by parallel-agents guardrails; use a worktree or read_only");
  }
}
