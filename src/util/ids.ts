export function sanitizeId(input: string, fallback = "agent"): string {
  const value = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
  return value || fallback;
}
