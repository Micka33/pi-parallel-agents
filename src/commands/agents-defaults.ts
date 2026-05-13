import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { controlParallelAgent } from "../tools/control-parallel-agent.js";

export async function agentsDefaultsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const model = tokens[0];
  const thinking = tokens[1];
  if (!model && !thinking) {
    ctx.ui.notify("Usage: /agents-defaults <model> [thinking]", "warning");
    return;
  }
  const result = await controlParallelAgent({ action: "set_defaults", ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) }, ctx);
  ctx.ui.notify(JSON.stringify(result, null, 2), "info");
}
