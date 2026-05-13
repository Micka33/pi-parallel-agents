#!/usr/bin/env node
import { resolve } from "node:path";
import { appendEvent, getAgent, openStateDb, setAgentStatus } from "./state-db.mjs";

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const stateDb = required(options, "state-db");
  const agentId = required(options, "agent-id");
  const timeoutMs = Number(options["timeout-ms"] ?? 3000);
  const db = openStateDb(resolve(stateDb));
  try {
    const agent = getAgent(db, agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const pid = agent.pid ? Number(agent.pid) : null;
    let stopped = false;
    if (pid && isPidAlive(pid)) {
      process.kill(pid, "SIGTERM");
      stopped = waitUntilDead(pid, timeoutMs);
      if (!stopped && isPidAlive(pid)) {
        process.kill(pid, "SIGKILL");
        stopped = waitUntilDead(pid, 1000);
      }
    } else {
      stopped = true;
    }
    const updated = setAgentStatus(db, { agentId, status: "stopped", pid: null, lastError: stopped ? null : `Process ${pid} did not stop cleanly` });
    appendEvent(db, { agentId, eventType: "stop", payloadJson: JSON.stringify({ pid, stopped, timeoutMs }) });
    process.stdout.write(JSON.stringify({ ok: true, action: "stop", agent: updated, stopped }, null, 2) + "\n");
  } finally {
    db.close();
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitUntilDead(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return !isPidAlive(pid);
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { options };
}

function required(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === "") throw new Error(`Missing --${key}`);
  return String(value);
}

main();
