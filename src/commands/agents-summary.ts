import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getParallelAgents } from "../tools/get-parallel-agents.js";
import { resolveRepoRoot } from "../util/paths.js";
import { renderAgentsSummary } from "../tui/render-agents.js";

export async function agentsSummaryCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const repoRoot = resolveRepoRoot(ctx.cwd);
  const { agents } = getParallelAgents({ include: ["status", "summary", "results"] }, ctx);
  ctx.ui.notify(renderAgentsSummary(agents, repoRoot), "info");
}
