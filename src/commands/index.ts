import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentsAskCommand } from "./agents-ask.js";
import { agentsCleanCommand } from "./agents-clean.js";
import { agentsCommand } from "./agents.js";
import { agentsConsultCommand } from "./agents-consult.js";
import { agentsDefaultsCommand } from "./agents-defaults.js";
import { agentsOpenCommand } from "./agents-open.js";
import { agentsOpenArgumentCompletions } from "./agents-open-completions.js";
import { agentsResumeCommand } from "./agents-resume.js";
import { agentsRetryCommand } from "./agents-retry.js";
import { agentsReviewCommand } from "./agents-review.js";
import { agentsSteerCommand } from "./agents-steer.js";
import { agentsStopCommand } from "./agents-stop.js";
import { agentsSummaryArgumentCompletions } from "./agents-summary-completions.js";
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
    description: "Show status and summaries for non-cleaned parallel Pi sub-agents: /agents-summary [--all|--include-cleaned]",
    getArgumentCompletions: agentsSummaryArgumentCompletions,
    handler: agentsSummaryCommand,
  });

  pi.registerCommand("agents-stop", {
    description: "Stop a running parallel Pi sub-agent: /agents-stop <agent-id>",
    getArgumentCompletions: (argumentPrefix) => agentsOpenArgumentCompletions(argumentPrefix, options.getRepoRoot?.()),
    handler: agentsStopCommand,
  });

  pi.registerCommand("agents-resume", {
    description: "Resume a stopped/crashed parallel Pi sub-agent: /agents-resume <agent-id>",
    getArgumentCompletions: (argumentPrefix) => agentsOpenArgumentCompletions(argumentPrefix, options.getRepoRoot?.()),
    handler: agentsResumeCommand,
  });

  pi.registerCommand("agents-defaults", {
    description: "Set parallel-agent defaults: /agents-defaults <model> [thinking]",
    handler: agentsDefaultsCommand,
  });

  pi.registerCommand("agents-clean", {
    description: "Clean a stopped parallel Pi sub-agent: /agents-clean <agent-id> [--worktree] [--branch] [--session] [--force]",
    getArgumentCompletions: (argumentPrefix) => agentsOpenArgumentCompletions(argumentPrefix, options.getRepoRoot?.()),
    handler: agentsCleanCommand,
  });

  pi.registerCommand("agents-steer", {
    description: "Send immediate steering to a child agent: /agents-steer <agent-id> <message>",
    getArgumentCompletions: (argumentPrefix) => agentsOpenArgumentCompletions(argumentPrefix, options.getRepoRoot?.()),
    handler: agentsSteerCommand,
  });

  pi.registerCommand("agents-ask", {
    description: "Queue a durable follow-up message for a child agent: /agents-ask <agent-id> <message>",
    getArgumentCompletions: (argumentPrefix) => agentsOpenArgumentCompletions(argumentPrefix, options.getRepoRoot?.()),
    handler: agentsAskCommand,
  });

  pi.registerCommand("agents-consult", {
    description: "Ask an isolated temporary clone without polluting the source agent: /agents-consult <agent-id> <question>",
    getArgumentCompletions: (argumentPrefix) => agentsOpenArgumentCompletions(argumentPrefix, options.getRepoRoot?.()),
    handler: agentsConsultCommand,
  });

  pi.registerCommand("agents-retry", {
    description: "Retry a blocked outgoing question: /agents-retry <agent-id> <question-id>",
    getArgumentCompletions: (argumentPrefix) => agentsOpenArgumentCompletions(argumentPrefix, options.getRepoRoot?.()),
    handler: agentsRetryCommand,
  });

  pi.registerCommand("agents-review", {
    description: "Review parallel-agent results and suggested follow-ups: /agents-review [agent-id]",
    getArgumentCompletions: (argumentPrefix) => agentsOpenArgumentCompletions(argumentPrefix, options.getRepoRoot?.()),
    handler: agentsReviewCommand,
  });
}
