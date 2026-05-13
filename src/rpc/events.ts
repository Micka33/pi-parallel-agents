export interface ParallelAgentRpcEvent {
  type?: string;
  [key: string]: unknown;
}

export function isExtensionUiRequest(event: ParallelAgentRpcEvent): boolean {
  return event.type === "extension_ui_request";
}

export function extensionUiRequestMessage(event: ParallelAgentRpcEvent): string {
  const value = event.message ?? event.prompt ?? event.title ?? event.text;
  return typeof value === "string" ? value : JSON.stringify(event);
}
