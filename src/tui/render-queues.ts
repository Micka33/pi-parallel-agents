import type { QueueQuestionRow } from "../state/types.js";

export function renderQueueLine(question: QueueQuestionRow): string {
  const arrow = question.direction === "incoming" ? "←" : "→";
  const response = question.response ? ` · response: ${truncate(question.response, 80)}` : "";
  return `${arrow} ${question.question_id} ${question.mode}/${question.status}: ${truncate(question.message, 120)}${response}`;
}

export function renderQueueList(queue: QueueQuestionRow[] | undefined): string {
  if (!queue?.length) return "No queued questions.";
  return queue.map(renderQueueLine).join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
