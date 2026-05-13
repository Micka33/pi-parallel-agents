import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ParallelAgent } from "../state/types.js";
import { renderAgentDetails } from "./render-agents.js";

export function renderAgentsOverlay(agents: ParallelAgent[], repoRoot: string): string {
  if (agents.length === 0) return "No parallel agents recorded for this repo.";
  return [
    "Parallel agents overlay",
    "Actions: /agents-steer <id> <message> · /agents-ask <id> <message> · /agents-stop <id> · /agents-resume <id>",
    "",
    ...agents.map((agent) => renderAgentDetails(agent, repoRoot)),
  ].join("\n");
}

export function showAgentsOverlay(ctx: ExtensionCommandContext, agents: ParallelAgent[], repoRoot: string): void {
  // V2 keeps the overlay deliberately simple and portable across Pi modes:
  // render the tail/details plus actionable commands in a notification panel.
  ctx.ui.notify(renderAgentsOverlay(agents, repoRoot), "info");
}
