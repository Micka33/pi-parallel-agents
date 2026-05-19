import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StateReader } from "../state/state-reader.js";
import type { AgentStateRow, AgentStatus } from "../state/types.js";
import { resolveRepoRoot, stateDbPath } from "../util/paths.js";
import type { GetParallelAgentsInput } from "./schemas.js";

export interface ParallelAgentListItem {
  agentId: string;
  displayName: string;
  sessionId: string | null;
  status: AgentStatus;
}

export type GetParallelAgentsOutput = ParallelAgentListItem[];

export function getParallelAgents(params: GetParallelAgentsInput, ctx: ExtensionContext): GetParallelAgentsOutput {
  const repoRoot = resolveRepoRoot(params.repoRoot ?? ctx.cwd);
  const reader = new StateReader(stateDbPath(repoRoot));
  const readOptions = params.agentId ? { agentId: params.agentId } : { repoRoot };
  return reader.readAgents(readOptions).map(toParallelAgentListItem);
}

function toParallelAgentListItem(row: AgentStateRow): ParallelAgentListItem {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    sessionId: row.session_id,
    status: row.status,
  };
}
