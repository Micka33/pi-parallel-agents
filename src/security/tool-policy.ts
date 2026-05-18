import { MUTATING_BUILTIN_TOOLS, READ_ONLY_SAFE_BUILTIN_TOOLS, SUB_AGENT_CONTROL_TOOLS } from "../constants.js";

const mutatingTools = new Set<string>(MUTATING_BUILTIN_TOOLS);
const readOnlySafeTools = new Set<string>([...READ_ONLY_SAFE_BUILTIN_TOOLS, ...SUB_AGENT_CONTROL_TOOLS]);

export function resolveChildAllowedTools(input: { inheritedTools: string[] | undefined; allowedTools: string[] | undefined; readOnly: boolean; maxSubAgents: number }): string[] | undefined {
  const explicitAllowlist = input.allowedTools !== undefined;
  const base = dedupeTools(explicitAllowlist ? input.allowedTools : input.inheritedTools);
  if (!input.readOnly) return base;

  if (input.allowedTools !== undefined) {
    const rejected = input.allowedTools.filter((tool) => mutatingTools.has(tool));
    if (rejected.length > 0) throw new Error(`readOnly=true cannot explicitly allow mutating tools: ${rejected.join(", ")}`);
  }

  const candidates = base ?? [...READ_ONLY_SAFE_BUILTIN_TOOLS, ...SUB_AGENT_CONTROL_TOOLS];
  return candidates.filter((tool) => readOnlySafeTools.has(tool) && (tool !== "start_agent" || input.maxSubAgents > 0));
}

function dedupeTools(tools: string[] | undefined): string[] | undefined {
  if (tools === undefined) return undefined;
  return Array.from(new Set(tools.map((tool) => tool.trim()).filter(Boolean)));
}
