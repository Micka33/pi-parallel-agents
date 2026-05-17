import type { AutocompleteItem } from "@earendil-works/pi-tui";

const INCLUDE_CLEANED_FLAGS = new Set(["--all", "--include-cleaned"]);
const SUMMARY_OPTION_COMPLETIONS: AutocompleteItem[] = [
  { value: "--all", label: "--all", description: "Include cleaned parallel agents." },
  { value: "--include-cleaned", label: "--include-cleaned", description: "Include cleaned parallel agents." },
];

export function agentsSummaryArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const tokens = argumentPrefix.trim().split(/\s+/).filter(Boolean);
  if (tokens.some((token) => !token.startsWith("--"))) return null;
  if (tokens.some((token) => INCLUDE_CLEANED_FLAGS.has(token))) return null;

  const currentToken = /\s$/.test(argumentPrefix) ? "" : (tokens.at(-1) ?? "");
  const matches = SUMMARY_OPTION_COMPLETIONS.filter((item) => item.value.startsWith(currentToken));
  return matches.length > 0 ? matches : null;
}
