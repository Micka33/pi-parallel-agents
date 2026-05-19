import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { agentsOpenArgumentCompletions } from "./agents-open-completions.js";

const CLEAN_FLAG_COMPLETIONS: AutocompleteItem[] = [
  { value: "--worktree", label: "--worktree", description: "Remove the agent worktree when safe." },
  { value: "--branch", label: "--branch", description: "Delete the agent branch." },
  { value: "--session", label: "--session", description: "Remove the agent session file." },
  { value: "--delete-history", label: "--delete-history", description: "Delete the agent row instead of marking it cleaned." },
  { value: "--force", label: "--force", description: "Force dirty worktree removal or branch deletion." },
];

export function agentsCleanArgumentCompletions(argumentPrefix: string, repoRoot: string | undefined): AutocompleteItem[] | null {
  const endsWithWhitespace = /\s$/.test(argumentPrefix);
  const tokens = argumentPrefix.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0 || (tokens.length === 1 && !endsWithWhitespace)) {
    const current = tokens[0] ?? "";
    return current.startsWith("--") ? null : agentsOpenArgumentCompletions(current, repoRoot);
  }

  const agentId = tokens[0]!;
  if (agentId.startsWith("--")) return null;

  const currentToken = endsWithWhitespace ? "" : tokens[tokens.length - 1]!;
  if (currentToken && !currentToken.startsWith("--")) return null;

  const completedFlags = endsWithWhitespace ? tokens.slice(1) : tokens.slice(1, -1);
  if (completedFlags.some((token) => !token.startsWith("--"))) return null;

  const usedFlags = new Set(completedFlags);
  const matches = CLEAN_FLAG_COMPLETIONS.filter((item) => !usedFlags.has(item.value) && item.value.startsWith(currentToken));
  return matches.length > 0 ? matches : null;
}
