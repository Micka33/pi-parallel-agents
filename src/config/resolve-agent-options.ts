import type { ParallelAgentDefaults } from "./defaults.js";

const READ_ONLY_REJECTED_TOOLS = new Set(["bash", "edit", "write"]);

export interface StartAgentSpec {
  name?: string;
  prompt: string;
  dedicatedWorktree?: boolean;
  inheritContext?: boolean;
  systemPrompt?: string;
  readOnly?: boolean;
  singleResponse?: boolean;
  waitUntil?: "started" | "initial_response";
  waitTimeoutMs?: number;
  maxSubAgents?: number;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  allowedTools?: string[];
  keep?: boolean;
}

export interface StartDefaultsInput {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinking?: string;
}

export interface ParentModelDefaults {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}

export interface ResolvedAgentOptions {
  name: string;
  prompt: string;
  dedicatedWorktree: boolean;
  inheritContext: boolean;
  readOnly: boolean;
  singleResponse: boolean;
  waitUntil: "started" | "initial_response";
  waitTimeoutMs?: number;
  maxSubAgents: number;
  keep: boolean;
  model: string;
  thinking: string;
  thinkingLevel: string;
  provider?: string;
  systemPrompt?: string;
  allowedTools?: string[];
}

export function resolveStartAgentOptions(
  spec: StartAgentSpec,
  defaults: StartDefaultsInput,
  configuredDefaults: ParallelAgentDefaults,
  parentModel: ParentModelDefaults = {},
): ResolvedAgentOptions {
  if (!spec.prompt?.trim()) throw new Error("start_agent requires a non-empty prompt");

  const dedicatedWorktree = spec.dedicatedWorktree ?? true;
  const readOnly = spec.readOnly ?? !dedicatedWorktree;
  const singleResponse = spec.singleResponse ?? false;
  const waitUntil = spec.waitUntil ?? (singleResponse ? "initial_response" : "started");
  const waitTimeoutMs = spec.waitTimeoutMs;
  const inheritContext = spec.inheritContext ?? false;
  const maxSubAgents = spec.maxSubAgents ?? 0;
  if (waitUntil !== "started" && waitUntil !== "initial_response") throw new Error(`waitUntil must be 'started' or 'initial_response'; got ${spec.waitUntil}`);
  if (singleResponse && spec.waitUntil === "started") throw new Error("singleResponse=true always waits for the response; omit waitUntil or use waitUntil='initial_response'.");
  if (waitTimeoutMs !== undefined && (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1)) throw new Error(`waitTimeoutMs must be a positive integer; got ${spec.waitTimeoutMs}`);
  if (!Number.isInteger(maxSubAgents) || maxSubAgents < 0) throw new Error(`maxSubAgents must be a non-negative integer; got ${spec.maxSubAgents}`);
  if (!dedicatedWorktree && !readOnly) {
    throw new Error("dedicatedWorktree=false with readOnly=false is blocked by parallel-agents guardrails; use a dedicated worktree for write access.");
  }

  const allowedTools = normalizeAllowedTools(spec.allowedTools);
  if (readOnly) assertReadOnlyAllowedTools(allowedTools);

  const provider = spec.provider ?? defaults.defaultProvider ?? parentModel.provider;
  const thinkingLevel = spec.thinkingLevel ?? defaults.defaultThinking ?? parentModel.thinkingLevel ?? configuredDefaults.thinking;

  return compactOptions({
    name: safeName(spec.name ?? "agent"),
    prompt: spec.prompt,
    dedicatedWorktree,
    inheritContext,
    readOnly,
    singleResponse,
    waitUntil,
    ...(waitTimeoutMs !== undefined ? { waitTimeoutMs } : {}),
    maxSubAgents,
    keep: spec.keep ?? false,
    ...(provider ? { provider } : {}),
    model: spec.model ?? defaults.defaultModel ?? parentModel.model ?? configuredDefaults.model,
    thinking: thinkingLevel,
    thinkingLevel,
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  });
}

function normalizeAllowedTools(tools: string[] | undefined): string[] | undefined {
  if (!tools) return undefined;
  const normalized = tools.map((tool) => tool.trim()).filter(Boolean);
  return Array.from(new Set(normalized));
}

function assertReadOnlyAllowedTools(tools: string[] | undefined): void {
  const rejected = tools?.filter((tool) => READ_ONLY_REJECTED_TOOLS.has(tool)) ?? [];
  if (rejected.length > 0) {
    throw new Error(`readOnly=true cannot explicitly allow mutating tools: ${rejected.join(", ")}`);
  }
}

function safeName(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 80) || "agent";
}

function compactOptions(options: ResolvedAgentOptions): ResolvedAgentOptions {
  const metadataKeys = ["dedicatedWorktree", "inheritContext", "readOnly", "singleResponse", "waitUntil", "waitTimeoutMs", "maxSubAgents", "keep", "thinkingLevel", "systemPrompt", "allowedTools"] as const;
  for (const key of metadataKeys) {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      Object.defineProperty(options, key, { value: options[key], enumerable: false, writable: true, configurable: true });
    }
  }
  return options;
}
