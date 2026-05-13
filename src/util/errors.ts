export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return error.stack ? { name: error.name, message: error.message, stack: error.stack } : { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}
