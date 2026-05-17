import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { controlParallelAgent } from "../tools/control-parallel-agent.js";

export async function agentsReviewCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const agentId = args.trim() || undefined;
  const result = await controlParallelAgent({ action: "review_results", ...(agentId ? { agentId } : {}) }, ctx);
  if (isReviewResult(result)) ctx.ui.notify(result.markdown, "info");
  else ctx.ui.notify(JSON.stringify(result, null, 2), "info");
}

function isReviewResult(value: unknown): value is { markdown: string } {
  return Boolean(value && typeof value === "object" && typeof (value as { markdown?: unknown }).markdown === "string");
}
