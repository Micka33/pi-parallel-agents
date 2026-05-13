import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getParallelAgents } from "../tools/get-parallel-agents.js";
import { resolveRepoRoot } from "../util/paths.js";
import { renderAgentsList } from "../tui/render-agents.js";
import { updateParallelAgentsWidget } from "../tui/widget.js";

export async function agentsCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const repoRoot = resolveRepoRoot(ctx.cwd);
  const { agents } = getParallelAgents({}, ctx);
  ctx.ui.notify(renderAgentsList(agents, repoRoot), "info");
  updateParallelAgentsWidget(ctx, repoRoot);
}
