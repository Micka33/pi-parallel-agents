#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  appendEvent,
  claimQueuedAgentCommands,
  completeAgentCommand,
  enqueueAgentCommand,
  getSettings,
  initializeState,
  listAgentCommands,
  listAgents,
  listEvents,
  openStateDb,
  setAgentResult,
  setAgentStatus,
  setDefaults,
  upsertAgent,
} from "./state-db.mjs";

const VALID_ACTIONS = new Set([
  "init",
  "upsert-agent",
  "set-status",
  "append-event",
  "set-result",
  "set-defaults",
  "mark-done",
  "mark-crashed",
  "enqueue-command",
  "claim-commands",
  "complete-command",
  "list-commands",
  "list",
]);

function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const action = positional[0];
  if (!action || !VALID_ACTIONS.has(action)) usage(`Unknown or missing action: ${action ?? "<none>"}`);

  const stateDb = options["state-db"] ?? process.env.PI_PARALLEL_AGENTS_DB_PATH;
  if (!stateDb) usage("Missing --state-db (or PI_PARALLEL_AGENTS_DB_PATH)");

  const db = openStateDb(resolve(String(stateDb)));
  try {
    let result;
    switch (action) {
      case "init":
        initializeState(db);
        result = { ok: true, action, stateDb: resolve(String(stateDb)), settings: getSettings(db) };
        break;
      case "upsert-agent": {
        const agent = readJsonOption(options, "agent-json");
        result = { ok: true, action, agent: upsertAgent(db, agent) };
        break;
      }
      case "set-status":
        result = {
          ok: true,
          action,
          agent: setAgentStatus(db, {
            agentId: required(options, "agent-id"),
            status: required(options, "status"),
            ...(Object.prototype.hasOwnProperty.call(options, "pid") ? { pid: parsePid(options.pid) } : {}),
            ...(Object.prototype.hasOwnProperty.call(options, "last-error") ? { lastError: String(options["last-error"]) } : {}),
          }),
        };
        break;
      case "append-event":
        result = {
          ok: true,
          action,
          event: appendEvent(db, {
            agentId: required(options, "agent-id"),
            eventType: required(options, "event-type"),
            payloadJson: options["payload-json"] ? normalizeJsonString(String(options["payload-json"])) : null,
          }),
        };
        break;
      case "set-result":
        result = {
          ok: true,
          action,
          agent: setAgentResult(db, {
            agentId: required(options, "agent-id"),
            summary: optionalString(options, "summary"),
            diffSummary: optionalString(options, "diff-summary"),
            testsJson: options["tests-json"] ? normalizeJsonString(String(options["tests-json"])) : undefined,
            status: optionalString(options, "status"),
          }),
        };
        break;
      case "set-defaults":
        setDefaults(db, { model: optionalString(options, "model"), thinking: optionalString(options, "thinking") });
        result = { ok: true, action, settings: getSettings(db) };
        break;
      case "mark-done":
        result = {
          ok: true,
          action,
          agent: setAgentResult(db, {
            agentId: required(options, "agent-id"),
            summary: optionalString(options, "summary"),
            diffSummary: optionalString(options, "diff-summary"),
            testsJson: options["tests-json"] ? normalizeJsonString(String(options["tests-json"])) : undefined,
            status: "done",
          }),
        };
        break;
      case "mark-crashed":
        result = {
          ok: true,
          action,
          agent: setAgentStatus(db, {
            agentId: required(options, "agent-id"),
            status: "crashed",
            pid: null,
            lastError: optionalString(options, "last-error") ?? "marked crashed",
          }),
        };
        break;
      case "enqueue-command":
        result = {
          ok: true,
          action,
          command: enqueueAgentCommand(db, {
            agentId: required(options, "agent-id"),
            commandType: required(options, "command-type"),
            payloadJson: options["payload-json"] ? normalizeJsonString(String(options["payload-json"])) : {},
          }),
        };
        break;
      case "claim-commands":
        result = {
          ok: true,
          action,
          commands: claimQueuedAgentCommands(db, { agentId: required(options, "agent-id"), limit: Number(options.limit ?? 10) }),
        };
        break;
      case "complete-command":
        result = {
          ok: true,
          action,
          command: completeAgentCommand(db, {
            commandId: Number(required(options, "command-id")),
            status: required(options, "status"),
            responseJson: options["response-json"] ? normalizeJsonString(String(options["response-json"])) : undefined,
            lastError: optionalString(options, "last-error"),
          }),
        };
        break;
      case "list-commands":
        result = {
          ok: true,
          action,
          commands: listAgentCommands(db, {
            agentId: optionalString(options, "agent-id"),
            status: optionalString(options, "status"),
            limit: Number(options.limit ?? 50),
          }),
        };
        break;
      case "list":
        result = {
          ok: true,
          action,
          agents: listAgents(db, { repoRoot: optionalString(options, "repo-root"), agentId: optionalString(options, "agent-id") }),
          events: options.events ? listEvents(db, { agentId: optionalString(options, "agent-id"), limit: Number(options.limit ?? 50) }) : undefined,
          commands: options.commands ? listAgentCommands(db, { agentId: optionalString(options, "agent-id"), limit: Number(options.limit ?? 50) }) : undefined,
          settings: getSettings(db),
        };
        break;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    db.close();
  }
}

function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

function readJsonOption(options, key) {
  const value = required(options, key);
  const text = String(value).trim().startsWith("{") ? String(value) : readFileSync(String(value), "utf8");
  return JSON.parse(text);
}

function normalizeJsonString(value) {
  JSON.parse(value);
  return value;
}

function required(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === "") usage(`Missing --${key}`);
  return String(value);
}

function optionalString(options, key) {
  const value = options[key];
  if (value === undefined || value === true) return undefined;
  return String(value);
}

function parsePid(value) {
  if (value === null || value === undefined || value === "" || value === "null") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) usage(`Invalid --pid: ${value}`);
  return number;
}

function usage(message) {
  process.stderr.write(`${message}\n\nUsage:\n  parallel-agent-state.sh init --state-db <path>\n  parallel-agent-state.sh upsert-agent --state-db <path> --agent-json <path-or-json>\n  parallel-agent-state.sh set-status --state-db <path> --agent-id <id> --status <status> [--pid <pid|null>] [--last-error <text>]\n  parallel-agent-state.sh append-event --state-db <path> --agent-id <id> --event-type <type> [--payload-json <json>]\n  parallel-agent-state.sh set-defaults --state-db <path> [--model <model>] [--thinking <level>]
  parallel-agent-state.sh enqueue-command --state-db <path> --agent-id <id> --command-type <type> --payload-json <json>
  parallel-agent-state.sh complete-command --state-db <path> --command-id <id> --status <succeeded|failed|canceled> [--response-json <json>] [--last-error <text>]\n`);
  process.exit(2);
}

main();
