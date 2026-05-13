export function logDebug(..._args: unknown[]): void {
  if (process.env.PI_PARALLEL_AGENTS_DEBUG === "1") {
    // eslint-disable-next-line no-console
    console.error("[parallel-agents]", ..._args);
  }
}
