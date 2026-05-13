import { randomUUID } from "node:crypto";

export function createQuestionId(agentId: string, prefix = "q"): string {
  return sanitizeQuestionId(`${prefix}-${agentId}-${Date.now()}-${randomUUID().slice(0, 8)}`);
}

export function sanitizeQuestionId(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^[._:-]+|[._:-]+$/g, "")
    .slice(0, 140) || `q-${Date.now()}`;
}
