export type PiRpcCommandType = "prompt" | "get_state" | "set_thinking_level" | "steer" | "follow_up" | "abort" | "extension_ui_response";

export interface PiRpcCommand {
  id?: string;
  type: PiRpcCommandType;
  [key: string]: unknown;
}

export interface PiRpcResponse<T = unknown> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}
