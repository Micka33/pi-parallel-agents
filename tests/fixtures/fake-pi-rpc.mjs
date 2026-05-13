#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const args = process.argv.slice(2);

if (args.includes("--mode") && args[args.indexOf("--mode") + 1] === "rpc") {
  runRpc();
} else {
  // Naming-agent / print-mode fallback.
  process.stdout.write(JSON.stringify({ displayName: "fake", worktreeName: "agent-fake", branchName: "agent-fake" }) + "\n");
}

function runRpc() {
  let isStreaming = false;
  let thinkingLevel = valueAfter("--thinking") ?? "high";
  const sessionId = `fake-session-${process.pid}`;
  const sessionDir = resolve(process.cwd(), ".pi", "fake-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(sessionFile, JSON.stringify({ sessionId, pid: process.pid }) + "\n");

  attachJsonlReader(process.stdin, (line) => {
    let command;
    try {
      command = JSON.parse(line);
    } catch (error) {
      respond({ type: "response", command: "parse", success: false, error: error.message });
      return;
    }
    const id = command.id;
    if (command.type === "prompt") {
      isStreaming = true;
      respond({ id, type: "response", command: "prompt", success: true });
      event({ type: "agent_start" });
      setTimeout(() => {
        event({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
        event({ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text: "fake done" }] }, toolResults: [] });
        isStreaming = false;
        event({ type: "agent_end", messages: [] });
      }, 200);
      return;
    }
    if (command.type === "get_state") {
      respond({
        id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          model: { id: valueAfter("--model") ?? "fake-model", provider: valueAfter("--provider") ?? "fake" },
          thinkingLevel,
          isStreaming,
          isCompacting: false,
          sessionFile,
          sessionId,
          messageCount: 1,
          pendingMessageCount: 0,
        },
      });
      return;
    }
    if (command.type === "set_thinking_level") {
      thinkingLevel = command.level;
      respond({ id, type: "response", command: "set_thinking_level", success: true });
      return;
    }
    if (command.type === "abort") {
      isStreaming = false;
      respond({ id, type: "response", command: "abort", success: true });
      return;
    }
    respond({ id, type: "response", command: command.type, success: true });
  });
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function respond(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function event(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  });
}
