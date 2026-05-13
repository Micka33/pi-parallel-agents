import { DEFAULT_MODEL, DEFAULT_THINKING } from "../constants.js";
import type { ParallelAgentSettings } from "../state/types.js";

export interface ParallelAgentDefaults {
  model: string;
  thinking: string;
}

export function defaultsFromSettings(settings: ParallelAgentSettings): ParallelAgentDefaults {
  return {
    model: typeof settings.default_model === "string" && settings.default_model.trim() ? settings.default_model : DEFAULT_MODEL,
    thinking:
      typeof settings.default_thinking === "string" && settings.default_thinking.trim()
        ? settings.default_thinking
        : DEFAULT_THINKING,
  };
}
