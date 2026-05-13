import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { PiRpcCommand, PiRpcResponse } from "./commands.js";

export class PiRpcClient {
  readonly process: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<string, { resolve: (value: PiRpcResponse) => void; reject: (error: Error) => void }>();

  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
    this.process = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    attachJsonlReader(this.process.stdout, (line) => this.#handleLine(line));
    this.process.on("exit", () => {
      for (const pending of this.#pending.values()) pending.reject(new Error("Pi RPC exited"));
      this.#pending.clear();
    });
  }

  send(command: Omit<PiRpcCommand, "id">): Promise<PiRpcResponse> {
    const id = `rpc-${this.#nextId++}`;
    const payload = { id, ...command };
    const promise = new Promise<PiRpcResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  #handleLine(line: string): void {
    const message = JSON.parse(line) as PiRpcResponse;
    if (message.type === "response" && message.id && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id)!;
      this.#pending.delete(message.id);
      if (message.success === false) pending.reject(new Error(message.error ?? `${message.command} failed`));
      else pending.resolve(message);
    }
  }
}

function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  });
}
