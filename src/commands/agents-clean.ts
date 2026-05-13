import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { controlParallelAgent } from "../tools/control-parallel-agent.js";

export async function agentsCleanCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const agentId = tokens.shift();
  if (!agentId) {
    ctx.ui.notify("Usage: /agents-clean <agent-id> [--worktree] [--branch] [--session] [--delete-history] [--force]", "warning");
    return;
  }
  const flags = new Set(tokens);
  const result = await controlParallelAgent(
    {
      action: "clean",
      agentId,
      removeWorktree: flags.has("--worktree") || flags.has("--remove-worktree"),
      removeBranch: flags.has("--branch") || flags.has("--remove-branch"),
      removeSession: flags.has("--session") || flags.has("--remove-session"),
      deleteHistory: flags.has("--delete-history"),
      force: flags.has("--force"),
    },
    ctx,
  );
  ctx.ui.notify(JSON.stringify(result, null, 2), "info");
}
