export function safeJsonParse<T = unknown>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
