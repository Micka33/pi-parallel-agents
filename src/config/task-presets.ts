import { readFileSync } from "node:fs";
import { promptPath } from "../util/paths.js";
import type { ResolvedAgentOptions } from "./resolve-agent-options.js";

export function buildChildPrompt(options: ResolvedAgentOptions, parentPrompt: string): string {
  const basePrompt = readPrompt(options.readOnly ? "child-read-only.md" : "child-agent.md");
  const parentSection = parentPrompt.trim() ? ["", "Parent request:", parentPrompt] : [];
  return [
    basePrompt,
    ...parentSection,
    "",
    "Assigned sub-agent task:",
    options.prompt,
    "",
    "Execution metadata:",
    `- name: ${options.name}`,
    `- dedicatedWorktree: ${options.dedicatedWorktree}`,
    `- readOnly: ${options.readOnly}`,
    `- maxSubAgents: ${options.maxSubAgents}`,
    `- model/thinking: ${options.model}/${options.thinking}`,
  ].join("\n");
}

function readPrompt(name: string): string {
  return readFileSync(promptPath(name), "utf8").trim();
}
