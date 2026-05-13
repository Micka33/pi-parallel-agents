import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { statusGlyph } from "../state/selectors.js";
import { StateReader } from "../state/state-reader.js";
import type { AgentStateRow, AgentStatus } from "../state/types.js";
import { stateDbPath } from "../util/paths.js";

const MAX_COMPLETIONS = 20;
const STATUS_PRIORITY: Record<AgentStatus, number> = {
  running: 0,
  waiting: 1,
  starting: 2,
  done: 3,
  crashed: 4,
  stopped: 5,
  cleaned: 6,
};

export function agentsOpenArgumentCompletions(argumentPrefix: string, repoRoot: string | undefined): AutocompleteItem[] | null {
  if (!repoRoot) return null;

  try {
    const reader = new StateReader(stateDbPath(repoRoot));
    const rows = reader.readAgents({ repoRoot });
    if (rows.length === 0) return null;

    const query = argumentPrefix.trim().toLowerCase();
    const matches = rows
      .filter((row) => matchesAgent(row, query))
      .sort(compareAgentsForCompletion)
      .slice(0, MAX_COMPLETIONS)
      .map(agentCompletionItem);

    return matches.length > 0 ? matches : null;
  } catch {
    // Autocomplete should never make typing fail if the state DB is missing,
    // locked, or being migrated while the user types.
    return null;
  }
}

function matchesAgent(row: AgentStateRow, query: string): boolean {
  if (!query) return true;
  const haystack = [row.agent_id, row.display_name, row.status, row.workspace_mode, row.model ?? "", row.thinking ?? ""]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function agentCompletionItem(row: AgentStateRow): AutocompleteItem {
  const workspace = row.workspace_mode === "current" ? "current/read-only" : "worktree";
  const modelThinking = `${row.model ?? "?"}/${row.thinking ?? "?"}`;
  return {
    value: row.agent_id,
    label: row.display_name === row.agent_id ? row.agent_id : `${row.display_name} (${row.agent_id})`,
    description: `${statusGlyph(row.status)} ${row.status} · ${workspace} · ${modelThinking}`,
  };
}

function compareAgentsForCompletion(left: AgentStateRow, right: AgentStateRow): number {
  const byStatus = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
  if (byStatus !== 0) return byStatus;
  return right.updated_at.localeCompare(left.updated_at) || left.agent_id.localeCompare(right.agent_id);
}

