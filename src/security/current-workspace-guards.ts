import type { AccessMode, WorkspaceMode } from "../constants.js";

export function currentWorkspaceWarning(workspaceMode: WorkspaceMode, accessMode: AccessMode): string | undefined {
  if (workspaceMode !== "current") return undefined;
  return accessMode === "write"
    ? "This agent shares the current checkout and can modify it."
    : "This agent shares the current checkout and is read-only by default.";
}
