import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getParallelAgents } from "../tools/get-parallel-agents.js";
import { resolveRepoRoot } from "../util/paths.js";
import { renderAgentDetails } from "../tui/render-agents.js";

export async function agentsOpenCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const agentId = args.trim();
  if (!agentId) {
    ctx.ui.notify("Usage: /agents-open <agent-id>", "warning");
    return;
  }
  const repoRoot = resolveRepoRoot(ctx.cwd);
  const { agents } = getParallelAgents({ agentId, include: ["logs", "commands", "queues"] }, ctx);
  const agent = agents[0];
  if (!agent) {
    ctx.ui.notify(`Unknown parallel agent: ${agentId}`, "warning");
    return;
  }
  ctx.ui.notify(renderAgentDetails(agent, repoRoot), "info");
}
