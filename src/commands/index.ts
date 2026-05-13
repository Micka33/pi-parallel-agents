import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentsCommand } from "./agents.js";
import { agentsOpenCommand } from "./agents-open.js";
import { agentsOpenArgumentCompletions } from "./agents-open-completions.js";
import { agentsSummaryCommand } from "./agents-summary.js";

export interface RegisterParallelAgentCommandsOptions {
  getRepoRoot?: () => string | undefined;
}

export function registerParallelAgentCommands(pi: ExtensionAPI, options: RegisterParallelAgentCommandsOptions = {}): void {
  pi.registerCommand("agents", {
    description: "Show parallel Pi sub-agents for this repo.",
    handler: agentsCommand,
  });

  pi.registerCommand("agents-open", {
    description: "Show details for a parallel Pi sub-agent: /agents-open <agent-id>",
    getArgumentCompletions: (argumentPrefix) => agentsOpenArgumentCompletions(argumentPrefix, options.getRepoRoot?.()),
    handler: agentsOpenCommand,
  });

  pi.registerCommand("agents-summary", {
    description: "Show status and summaries for parallel Pi sub-agents.",
    handler: agentsSummaryCommand,
  });
}
