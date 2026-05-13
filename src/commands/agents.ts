import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getParallelAgents } from "../tools/get-parallel-agents.js";
import { resolveRepoRoot } from "../util/paths.js";
import { showAgentsOverlay } from "../tui/overlay.js";
import { updateParallelAgentsWidget } from "../tui/widget.js";

export async function agentsCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const repoRoot = resolveRepoRoot(ctx.cwd);
  const { agents } = getParallelAgents({ include: ["logs", "commands", "queues"] }, ctx);
  showAgentsOverlay(ctx, agents, repoRoot);
  updateParallelAgentsWidget(ctx, repoRoot);
}
