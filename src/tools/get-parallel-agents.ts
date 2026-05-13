import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StateReader } from "../state/state-reader.js";
import { toParallelAgent } from "../state/selectors.js";
import type { ParallelAgent } from "../state/types.js";
import { queueAdapterForRepo } from "../queues/question-router.js";
import { resolveRepoRoot, stateDbPath } from "../util/paths.js";
import type { GetParallelAgentsInput } from "./schemas.js";

export interface GetParallelAgentsOutput {
  agents: ParallelAgent[];
  count: number;
}

export function getParallelAgents(params: GetParallelAgentsInput, ctx: ExtensionContext): GetParallelAgentsOutput {
  const repoRoot = resolveRepoRoot(params.repoRoot ?? ctx.cwd);
  const reader = new StateReader(stateDbPath(repoRoot));
  const includeEvents = params.include?.includes("logs") ?? false;
  const includeCommands = params.include?.includes("commands") ?? false;
  const includeQueues = params.include?.includes("queues") ?? false;
  const readOptions = params.agentId ? { agentId: params.agentId } : { repoRoot };
  const rows = reader.readAgents(readOptions);
  const queueAdapter = includeQueues ? queueAdapterForRepo(repoRoot) : undefined;
  const agents = rows.map((row) =>
    toParallelAgent(
      row,
      includeEvents ? reader.readEvents(row.agent_id) : undefined,
      includeCommands ? reader.readCommands(row.agent_id) : undefined,
      includeQueues ? queueAdapter?.listQuestions({ agentId: row.agent_id }) : undefined,
    ),
  );
  return { agents, count: agents.length };
}
