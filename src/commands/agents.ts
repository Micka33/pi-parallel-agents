import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getParallelAgentDetails } from "../tools/get-parallel-agent-details.js";
import { resolveRepoRoot } from "../util/paths.js";
import { showAgentsOverlay } from "../tui/overlay.js";
import { updateParallelAgentsWidget } from "../tui/widget.js";

export async function agentsCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const repoRoot = resolveRepoRoot(ctx.cwd);
  const { agents } = getParallelAgentDetails({ include: ["logs", "commands", "queues"] }, ctx);
  showAgentsOverlay(ctx, agents, repoRoot);
  updateParallelAgentsWidget(ctx, repoRoot);
}
