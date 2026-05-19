import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getParallelAgentDetails } from "../tools/get-parallel-agent-details.js";
import { resolveRepoRoot } from "../util/paths.js";
import { renderAgentsSummary } from "../tui/render-agents.js";

export async function agentsSummaryCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const repoRoot = resolveRepoRoot(ctx.cwd);
  const includeCleaned = shouldIncludeCleaned(args);
  const { agents } = getParallelAgentDetails({ include: ["status", "summary", "results", "queues"] }, ctx);
  const visibleAgents = includeCleaned ? agents : agents.filter((agent) => agent.status !== "cleaned");
  if (visibleAgents.length === 0) {
    const cleanedCount = agents.filter((agent) => agent.status === "cleaned").length;
    const hint = !includeCleaned && cleanedCount > 0 ? `\nUse /agents-summary --all to include cleaned agents (${cleanedCount}).` : "";
    ctx.ui.notify(`No parallel agents for this repo.${hint}`, "info");
    return;
  }
  ctx.ui.notify(renderAgentsSummary(visibleAgents, repoRoot), "info");
}

function shouldIncludeCleaned(args: string): boolean {
  const flags = new Set(args.trim().split(/\s+/).filter(Boolean));
  return flags.has("--all") || flags.has("--include-cleaned");
}
