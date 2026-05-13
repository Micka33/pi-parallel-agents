export interface PiSessionState {
  sessionId?: string | null;
  sessionFile?: string | null;
  thinkingLevel?: string | null;
  isStreaming?: boolean;
}

export function extractSessionState(data: unknown): PiSessionState {
  if (!data || typeof data !== "object") return {};
  const value = data as Record<string, unknown>;
  return {
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : null,
    thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : null,
    isStreaming: Boolean(value.isStreaming),
  };
}
