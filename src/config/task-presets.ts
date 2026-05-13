import { readFileSync } from "node:fs";
import { promptPath } from "../util/paths.js";
import type { ResolvedAgentOptions } from "./resolve-agent-options.js";

export function buildChildPrompt(options: ResolvedAgentOptions, parentPrompt: string): string {
  const basePrompt = readPrompt(options.accessMode === "read_only" ? "child-read-only.md" : "child-agent.md");
  return [
    basePrompt,
    "",
    "Parent request:",
    parentPrompt || "(not provided)",
    "",
    "Assigned sub-agent task:",
    options.prompt,
    "",
    "Execution metadata:",
    `- name: ${options.name}`,
    `- workspaceMode: ${options.workspaceMode}`,
    `- accessMode: ${options.accessMode}`,
    `- model/thinking: ${options.model}/${options.thinking}`,
  ].join("\n");
}

function readPrompt(name: string): string {
  return readFileSync(promptPath(name), "utf8").trim();
}
