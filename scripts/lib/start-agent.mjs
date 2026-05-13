#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  appendEvent,
  claimQueuedAgentCommands,
  completeAgentCommand,
  getAgent,
  initializeState,
  listAgents,
  openStateDb,
  setAgentStatus,
  upsertAgent,
} from "./state-db.mjs";
import { answerQuestion, createQuestion, markQuestionBlocked, markQuestionDelivered, openQueueDb } from "./queue-db.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoScriptRoot = resolve(__dirname, "..", "..");

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_THINKING = "high";
const VALID_WORKSPACE_MODES = new Set(["worktree", "current"]);
const VALID_ACCESS_MODES = new Set(["read_only", "write"]);
const EXTENSION_TOOLS = "get_parallel_agents,message_parallel_agent,reply_parallel_question,control_parallel_agent";
const READ_ONLY_TOOLS = `read,grep,find,ls,${EXTENSION_TOOLS}`;
const WRITE_TOOLS = `read,bash,edit,write,grep,find,ls,${EXTENSION_TOOLS}`;
const MAX_EVENT_PAYLOAD = 24_000;

if (process.argv[2] === "--supervise") {
  supervise(process.argv[3]).catch((error) => {
    // Last-resort logging for detached mode. The normal start path reads the result file.
    try {
      const configPath = process.argv[3];
      const config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : null;
      if (config?.resultFile) writeResult(config.resultFile, { ok: false, error: serializeError(error) });
      if (config?.stateDb && config?.agent?.agent_id) {
        const db = openStateDb(config.stateDb);
        try {
          setAgentStatus(db, { agentId: config.agent.agent_id, status: "crashed", pid: null, lastError: error.message });
        } finally {
          db.close();
        }
      }
    } catch {}
    process.exit(1);
  });
} else {
  start().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

async function start() {
  const { options } = parseArgs(process.argv.slice(2));
  if (Object.prototype.hasOwnProperty.call(options, "resume-session")) {
    await startResume(options);
    return;
  }

  const contextPath = required(options, "context");
  const promptPath = required(options, "prompt");
  const context = readJsonFile(contextPath);
  const promptText = readFileSync(promptPath, "utf8");

  const repoRoot = resolveRepoRoot(context.repoRoot ? resolve(String(context.repoRoot)) : process.cwd());
  const runtimeDir = resolve(repoRoot, ".pi", "parallel-agents");
  const stateDb = resolve(String(options["state-db"] ?? process.env.PI_PARALLEL_AGENTS_DB_PATH ?? join(runtimeDir, "state.sqlite")));
  const tasksDb = resolve(String(options["tasks-db"] ?? process.env.PI_TASKS_DB_PATH ?? join(runtimeDir, "tasks.sqlite")));
  const model = String(options.model ?? context.model ?? DEFAULT_MODEL);
  const thinking = String(options.thinking ?? context.thinking ?? DEFAULT_THINKING);
  const provider = optionalString(options.provider ?? context.provider);
  const workspaceMode = String(options["workspace-mode"] ?? context.workspaceMode ?? "worktree");
  if (!VALID_WORKSPACE_MODES.has(workspaceMode)) throw new Error(`Invalid workspace mode: ${workspaceMode}`);
  if (workspaceMode === "worktree") assertGitRepository(repoRoot);
  const accessMode = resolveAccessMode(options["access-mode"] ?? context.accessMode, workspaceMode);
  const parentSessionId = String(context.parentSessionId ?? process.env.PI_PARENT_SESSION_ID ?? "unknown-parent-session");
  const requestedName = String(context.name ?? context.suggestedName ?? context.agentName ?? "agent");
  const parentPrompt = String(context.parentPrompt ?? "");
  const agentPrompt = String(context.agentPrompt ?? promptText);

  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(join(runtimeDir, "tmp"), { recursive: true });
  mkdirSync(join(runtimeDir, "logs", "agents"), { recursive: true });

  const db = openStateDb(stateDb);
  try {
    initializeState(db);
    const existingAgents = listAgents(db, { repoRoot });
    const usedAgentIds = new Set(existingAgents.map((agent) => agent.agent_id));
    const naming = workspaceMode === "worktree" ? await proposeNames({ repoRoot, requestedName, parentPrompt, agentPrompt, provider, model }) : {};
    const displayName = safeDisplayName(naming.displayName ?? requestedName);
    const agentId = dedupeSlug(sanitizeSlug(displayName, "agent"), usedAgentIds);

    let cwd = repoRoot;
    let worktreePath = null;
    let branchName = null;

    if (workspaceMode === "worktree") {
      const baseName = sanitizeSlug(naming.worktreeName ?? requestedName, `agent-${Date.now()}`);
      const branchBaseName = sanitizeBranchName(naming.branchName ?? baseName, baseName);
      const worktreeBase = join(dirname(repoRoot), "pi");
      mkdirSync(worktreeBase, { recursive: true });
      const worktreeName = dedupeWorktreeName(worktreeBase, baseName, repoRoot);
      worktreePath = join(worktreeBase, worktreeName);
      branchName = dedupeBranchName(repoRoot, branchBaseName);
      createWorktree(repoRoot, worktreePath, branchName);
      cwd = worktreePath;
    }

    const agent = {
      agent_id: agentId,
      parent_session_id: parentSessionId,
      display_name: displayName,
      repo_root: repoRoot,
      status: "starting",
      workspace_mode: workspaceMode,
      access_mode: accessMode,
      pid: null,
      cwd,
      worktree_path: worktreePath,
      branch_name: branchName,
      provider: provider ?? null,
      model,
      thinking,
      session_id: null,
      session_file: null,
      summary: null,
      diff_summary: null,
      tests_json: null,
      last_error: null,
    };

    upsertAgent(db, agent);
    appendEvent(db, {
      agentId,
      eventType: "start_requested",
      payloadJson: JSON.stringify({ workspaceMode, accessMode, model, thinking, provider, cwd, worktreePath, branchName }),
    });

    const configPath = join(runtimeDir, "tmp", `${agentId}-${Date.now()}-supervisor.json`);
    const resultFile = join(runtimeDir, "tmp", `${agentId}-${Date.now()}-start-result.json`);
    const stdoutLog = join(runtimeDir, "logs", "agents", `${agentId}.stdout.jsonl`);
    const stderrLog = join(runtimeDir, "logs", "agents", `${agentId}.stderr.log`);
    const config = {
      agent,
      repoRoot,
      stateDb,
      tasksDb,
      promptText,
      provider,
      model,
      thinking,
      accessMode,
      cwd,
      resume: false,
      sessionFile: null,
      resultFile,
      stdoutLog,
      stderrLog,
      extensionPath: resolveExtensionPath(),
      piBin: String(process.env.PI_PARALLEL_AGENTS_PI_BIN || "pi"),
      startTimeoutMs: Number(process.env.PI_PARALLEL_AGENTS_START_TIMEOUT_MS || 30_000),
      commandTimeoutMs: Number(process.env.PI_PARALLEL_AGENTS_COMMAND_TIMEOUT_MS || 20_000),
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const supervisor = spawn(process.execPath, [__filename, "--supervise", configPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PI_PARALLEL_AGENTS_SUPERVISOR: "1",
      },
    });
    supervisor.unref();

    const result = await waitForResultFile(resultFile, config.startTimeoutMs);
    if (!result.ok) {
      const errorMessage = result.error?.message ?? JSON.stringify(result.error ?? result);
      setAgentStatus(db, { agentId, status: "crashed", pid: null, lastError: errorMessage });
      throw new Error(`Failed to start parallel agent ${agentId}: ${errorMessage}`);
    }

    process.stdout.write(JSON.stringify(result.agent, null, 2) + "\n");
  } finally {
    db.close();
  }
}

async function startResume(options) {
  const stateDb = resolve(String(options["state-db"] ?? process.env.PI_PARALLEL_AGENTS_DB_PATH ?? required(options, "state-db")));
  const agentId = optionalString(options["agent-id"]) ?? optionalString(options["resume-session"]);
  if (!agentId) throw new Error("Missing --agent-id for --resume-session");

  const db = openStateDb(stateDb);
  try {
    initializeState(db);
    const existing = getAgent(db, agentId);
    if (!existing) throw new Error(`Unknown agent: ${agentId}`);
    if (existing.pid && isPidAlive(Number(existing.pid))) {
      process.stdout.write(JSON.stringify(toStartResult(existing), null, 2) + "\n");
      return;
    }

    const repoRoot = resolve(String(existing.repo_root));
    const runtimeDir = resolve(repoRoot, ".pi", "parallel-agents");
    const tasksDb = resolve(String(options["tasks-db"] ?? process.env.PI_TASKS_DB_PATH ?? join(runtimeDir, "tasks.sqlite")));
    const promptPath = optionalString(options.prompt);
    const promptText = promptPath ? readFileSync(promptPath, "utf8") : null;
    const resumedAgent = upsertAgent(db, { agent_id: agentId, status: "starting", pid: null, last_error: null });
    appendEvent(db, {
      agentId,
      eventType: "resume_requested",
      payloadJson: JSON.stringify({ sessionFile: resumedAgent.session_file, cwd: resumedAgent.cwd }),
    });

    mkdirSync(join(runtimeDir, "tmp"), { recursive: true });
    mkdirSync(join(runtimeDir, "logs", "agents"), { recursive: true });
    const configPath = join(runtimeDir, "tmp", `${agentId}-${Date.now()}-resume-supervisor.json`);
    const resultFile = join(runtimeDir, "tmp", `${agentId}-${Date.now()}-resume-result.json`);
    const stdoutLog = join(runtimeDir, "logs", "agents", `${agentId}.stdout.jsonl`);
    const stderrLog = join(runtimeDir, "logs", "agents", `${agentId}.stderr.log`);
    const config = {
      agent: resumedAgent,
      repoRoot,
      stateDb,
      tasksDb,
      promptText,
      provider: resumedAgent.provider,
      model: resumedAgent.model ?? DEFAULT_MODEL,
      thinking: resumedAgent.thinking ?? DEFAULT_THINKING,
      accessMode: resumedAgent.access_mode,
      cwd: resumedAgent.cwd,
      resume: true,
      sessionFile: resumedAgent.session_file,
      resultFile,
      stdoutLog,
      stderrLog,
      extensionPath: resolveExtensionPath(),
      piBin: String(process.env.PI_PARALLEL_AGENTS_PI_BIN || "pi"),
      startTimeoutMs: Number(process.env.PI_PARALLEL_AGENTS_START_TIMEOUT_MS || 30_000),
      commandTimeoutMs: Number(process.env.PI_PARALLEL_AGENTS_COMMAND_TIMEOUT_MS || 20_000),
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const supervisor = spawn(process.execPath, [__filename, "--supervise", configPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PI_PARALLEL_AGENTS_SUPERVISOR: "1",
      },
    });
    supervisor.unref();

    const result = await waitForResultFile(resultFile, config.startTimeoutMs);
    if (!result.ok) {
      const errorMessage = result.error?.message ?? JSON.stringify(result.error ?? result);
      setAgentStatus(db, { agentId, status: "crashed", pid: null, lastError: errorMessage });
      throw new Error(`Failed to resume parallel agent ${agentId}: ${errorMessage}`);
    }
    process.stdout.write(JSON.stringify(result.agent, null, 2) + "\n");
  } finally {
    db.close();
  }
}

async function supervise(configPath) {
  if (!configPath) throw new Error("Missing supervisor config path");
  const config = readJsonFile(configPath);
  const db = openStateDb(config.stateDb);
  const queueDb = openQueueDb(config.tasksDb);
  let child;
  let commandPollTimer;
  let commandPollRunning = false;
  let started = false;
  let lastStatus = "starting";

  const failStart = (error) => {
    const serialized = serializeError(error);
    try {
      setAgentStatus(db, { agentId: config.agent.agent_id, status: "crashed", pid: null, lastError: serialized.message });
      appendEvent(db, { agentId: config.agent.agent_id, eventType: "start_failed", payloadJson: JSON.stringify(serialized) });
    } catch {}
    writeResult(config.resultFile, { ok: false, error: serialized });
  };

  try {
    initializeState(db);
    appendEvent(db, { agentId: config.agent.agent_id, eventType: "supervisor_start", payloadJson: JSON.stringify({ supervisorPid: process.pid }) });

    const childArgs = buildPiRpcArgs(config);
    child = spawn(config.piBin, childArgs, {
      cwd: config.cwd,
      env: {
        ...process.env,
        PI_PARALLEL_AGENTS_DB_PATH: config.stateDb,
        PI_TASKS_DB_PATH: config.tasksDb,
        PI_TASKS_AGENT_ID: `parallel-child:${config.agent.agent_id}`,
        PI_PARALLEL_AGENTS_REPO_ROOT: config.repoRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pending = new Map();
    let nextId = 1;

    child.on("error", (error) => {
      if (!started) failStart(error);
    });

    child.on("exit", (code, signal) => {
      if (commandPollTimer) clearInterval(commandPollTimer);
      const payload = { code, signal, pid: child.pid };
      try {
        appendEvent(db, { agentId: config.agent.agent_id, eventType: "process_exit", payloadJson: JSON.stringify(payload) });
        const current = db.prepare("SELECT status FROM agents WHERE agent_id = ?").get(config.agent.agent_id)?.status;
        if (current !== "stopped" && current !== "done" && current !== "cleaned") {
          setAgentStatus(db, {
            agentId: config.agent.agent_id,
            status: "crashed",
            pid: null,
            lastError: `Pi RPC exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          });
        }
      } catch {}
      for (const [, pendingCommand] of pending) {
        pendingCommand.reject(new Error(`Pi RPC exited before ${pendingCommand.command} response`));
      }
      pending.clear();
      try {
        queueDb.close();
      } catch {}
      db.close();
    });

    attachJsonlReader(child.stdout, (line) => {
      appendLog(config.stdoutLog, line + "\n");
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        appendEventSafe(db, config.agent.agent_id, "rpc_parse_error", { line: truncate(line, 1000), error: error.message });
        return;
      }

      if (message.type === "response" && message.id && pending.has(message.id)) {
        const pendingCommand = pending.get(message.id);
        pending.delete(message.id);
        if (message.success === false) {
          pendingCommand.reject(new Error(message.error ?? `${pendingCommand.command} failed`));
        } else {
          pendingCommand.resolve(message);
        }
        return;
      }

      handleRpcEvent(db, queueDb, config.agent.agent_id, message, child.pid, (status) => {
        lastStatus = status;
      });
    });

    child.stderr.on("data", (chunk) => appendLog(config.stderrLog, chunk));

    const sendNotification = (command) => {
      if (!child.stdin.writable) throw new Error("Pi RPC stdin is closed");
      child.stdin.write(`${JSON.stringify(command)}\n`);
    };

    const sendCommand = (command, timeoutMs = config.commandTimeoutMs) => {
      if (!child.stdin.writable) throw new Error("Pi RPC stdin is closed");
      const id = `parallel-${process.pid}-${nextId++}`;
      const payload = { id, ...command };
      const promise = new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectPromise(new Error(`Timed out waiting for ${command.type} response`));
        }, timeoutMs);
        pending.set(id, {
          command: command.type,
          resolve: (value) => {
            clearTimeout(timeout);
            resolvePromise(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            rejectPromise(error);
          },
        });
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      return promise;
    };

    if (config.promptText) {
      const promptResponse = await sendCommand({ type: "prompt", message: config.promptText });
      appendEvent(db, { agentId: config.agent.agent_id, eventType: "prompt_accepted", payloadJson: JSON.stringify({ response: promptResponse }) });
    }
    let stateResponse = await sendCommand({ type: "get_state" });
    let state = stateResponse.data ?? {};

    if (config.thinking && state.thinkingLevel && state.thinkingLevel !== config.thinking) {
      try {
        await sendCommand({ type: "set_thinking_level", level: config.thinking });
        stateResponse = await sendCommand({ type: "get_state" });
        state = stateResponse.data ?? {};
      } catch (error) {
        appendEvent(db, { agentId: config.agent.agent_id, eventType: "thinking_sync_failed", payloadJson: JSON.stringify(serializeError(error)) });
      }
    }

    const status = state.isStreaming ? "running" : "waiting";
    lastStatus = status;
    started = true;
    const updatedAgent = upsertAgent(db, {
      agent_id: config.agent.agent_id,
      pid: child.pid,
      status,
      session_id: state.sessionId ?? null,
      session_file: state.sessionFile ?? null,
      last_error: null,
    });
    appendEvent(db, {
      agentId: config.agent.agent_id,
      eventType: "rpc_started",
      payloadJson: JSON.stringify({ pid: child.pid, sessionId: state.sessionId ?? null, sessionFile: state.sessionFile ?? null, status }),
    });
    writeResult(config.resultFile, { ok: true, agent: toStartResult(updatedAgent) });

    commandPollTimer = setInterval(async () => {
      if (commandPollRunning) return;
      commandPollRunning = true;
      try {
        await deliverQueuedCommands(db, queueDb, config, child.pid, sendCommand, sendNotification);
      } catch (error) {
        appendEventSafe(db, config.agent.agent_id, "command_poll_error", serializeError(error));
      } finally {
        commandPollRunning = false;
      }
    }, Number(process.env.PI_PARALLEL_AGENTS_COMMAND_POLL_MS || 250));
    commandPollTimer.unref?.();
    void deliverQueuedCommands(db, queueDb, config, child.pid, sendCommand, sendNotification).catch((error) => {
      appendEventSafe(db, config.agent.agent_id, "command_poll_error", serializeError(error));
    });

    // Keep this supervisor alive to own the RPC pipes. All ongoing status updates are event-driven.
  } catch (error) {
    if (!started) failStart(error);
    else {
      setAgentStatus(db, { agentId: config.agent.agent_id, status: "crashed", pid: null, lastError: error.message });
      appendEvent(db, { agentId: config.agent.agent_id, eventType: "supervisor_error", payloadJson: JSON.stringify(serializeError(error)) });
      try {
        queueDb.close();
      } catch {}
      db.close();
    }
    if (child?.pid) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  }
}

function handleRpcEvent(db, queueDb, agentId, event, pid, setLastStatus) {
  const type = event.type || "unknown";
  if (type !== "message_update") {
    appendEventSafe(db, agentId, `rpc_${type}`, event);
  }
  if (type === "agent_start" || type === "turn_start") {
    setAgentStatus(db, { agentId, status: "running", pid });
    setLastStatus("running");
  } else if (type === "agent_end") {
    setAgentStatus(db, { agentId, status: "waiting", pid });
    setLastStatus("waiting");
  } else if (type === "extension_ui_request" && isDialogUiRequest(event)) {
    const question = questionFromUiRequest(agentId, event);
    createQuestion(queueDb, question);
    appendEventSafe(db, agentId, "ui_request_queued", { questionId: question.questionId, method: event.method ?? null });
    setAgentStatus(db, { agentId, status: "waiting", pid });
    setLastStatus("waiting");
  }
}

function isDialogUiRequest(event) {
  // Pi RPC docs distinguish blocking dialog methods from fire-and-forget UI
  // methods. Only blocking dialogs need a durable parent answer.
  return event.method === "select" || event.method === "confirm" || event.method === "input" || event.method === "editor";
}

async function deliverQueuedCommands(db, queueDb, config, pid, sendCommand, sendNotification) {
  const commands = claimQueuedAgentCommands(db, { agentId: config.agent.agent_id, limit: 10 });
  for (const command of commands) {
    let payload;
    try {
      payload = JSON.parse(command.payload_json);
    } catch (error) {
      completeAgentCommand(db, { commandId: command.id, status: "failed", lastError: `Invalid command payload JSON: ${error.message}` });
      continue;
    }

    const rpcCommand = normalizeRpcCommand(command.command_type, payload);
    const questionId = typeof payload.questionId === "string" ? payload.questionId : undefined;
    try {
      if (rpcCommand.type === "extension_ui_response") {
        sendNotification(rpcCommand);
        completeAgentCommand(db, { commandId: command.id, status: "succeeded", responseJson: { ok: true, fireAndForget: true } });
        if (questionId && typeof payload.response === "string") {
          answerQuestion(queueDb, { questionId, response: payload.response, status: "answered" });
        }
        continue;
      }
      const response = await sendCommand(rpcCommand);
      completeAgentCommand(db, { commandId: command.id, status: "succeeded", responseJson: response });
      if (questionId) markQuestionDelivered(queueDb, questionId);
      if (rpcCommand.type === "get_state" && response.data) updateAgentFromState(db, config.agent.agent_id, response.data, pid);
    } catch (error) {
      completeAgentCommand(db, { commandId: command.id, status: "failed", lastError: error.message });
      if (questionId) markQuestionBlocked(queueDb, questionId, error.message);
    }
  }
}

function normalizeRpcCommand(commandType, payload) {
  const rpc = payload.rpc && typeof payload.rpc === "object" ? { ...payload.rpc } : { ...payload };
  delete rpc.questionId;
  delete rpc.mode;
  if (!rpc.type) rpc.type = commandType;
  return rpc;
}

function updateAgentFromState(db, agentId, state, pid) {
  const status = state.isStreaming ? "running" : "waiting";
  upsertAgent(db, {
    agent_id: agentId,
    status,
    pid,
    session_id: state.sessionId ?? null,
    session_file: state.sessionFile ?? null,
    last_error: null,
  });
}

function questionFromUiRequest(agentId, event) {
  const rawId = event.id ?? event.requestId ?? event.uiRequestId ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const questionId = String(rawId).slice(0, 200) || `question-${Date.now()}`;
  const message = String(event.message ?? event.prompt ?? event.title ?? event.text ?? JSON.stringify(event));
  return {
    questionId,
    agentId,
    direction: "incoming",
    mode: "queue",
    status: "queued",
    message,
    metadataJson: JSON.stringify(event),
  };
}

function buildPiRpcArgs(config) {
  const args = ["--mode", "rpc"];
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.thinking) args.push("--thinking", config.thinking);
  if (config.resume && config.sessionFile) args.push("--session", config.sessionFile);
  if (shouldPassExplicitExtension(config)) args.push("--extension", config.extensionPath);
  args.push("--tools", config.accessMode === "read_only" ? READ_ONLY_TOOLS : WRITE_TOOLS);
  return args;
}

function shouldPassExplicitExtension(config) {
  if (!config.extensionPath) return false;
  // In current-workspace mode the child runs from the parent repo root, where
  // project-local .pi/extensions are auto-discovered. Passing the same extension
  // again through --extension makes Pi register the V1 tools twice and abort.
  // Worktree children usually do not have .pi/extensions, so keep explicit load
  // there to make bridge tools available.
  if (config.cwd === config.repoRoot && existsSync(join(config.cwd, ".pi", "extensions"))) return false;
  return true;
}

function resolveExtensionPath() {
  if (process.env.PI_PARALLEL_AGENTS_EXTENSION_PATH) return resolve(process.env.PI_PARALLEL_AGENTS_EXTENSION_PATH);
  const sourcePath = join(repoScriptRoot, "src", "parallel-agents.ts");
  if (existsSync(sourcePath)) return sourcePath;
  const distPath = join(repoScriptRoot, "dist", "src", "parallel-agents.js");
  if (existsSync(distPath)) return distPath;
  return null;
}

async function proposeNames({ repoRoot, requestedName, parentPrompt, agentPrompt, provider, model }) {
  const fallback = {
    displayName: requestedName,
    worktreeName: `agent-${sanitizeSlug(requestedName, "agent")}`,
    branchName: `agent-${sanitizeSlug(requestedName, "agent")}`,
  };

  if (process.env.PI_PARALLEL_AGENTS_NAMING_JSON) {
    try {
      return { ...fallback, ...JSON.parse(process.env.PI_PARALLEL_AGENTS_NAMING_JSON) };
    } catch {}
  }

  if (process.env.PI_PARALLEL_AGENTS_DISABLE_NAMING_AGENT === "1") return fallback;

  const piBin = process.env.PI_PARALLEL_AGENTS_PI_BIN || "pi";
  const namingPrompt = buildNamingPrompt({ repoRoot, requestedName, parentPrompt, agentPrompt });
  const args = [];
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  args.push("--thinking", "off", "--no-tools", "-p", namingPrompt);
  const result = spawnSync(piBin, args, { cwd: repoRoot, encoding: "utf8", timeout: Number(process.env.PI_PARALLEL_AGENTS_NAMING_TIMEOUT_MS || 60_000) });
  if (result.status !== 0 || result.error) return fallback;
  const parsed = parseFirstJsonObject(result.stdout);
  return parsed ? { ...fallback, ...parsed } : fallback;
}

function buildNamingPrompt({ repoRoot, requestedName, parentPrompt, agentPrompt }) {
  let template = "";
  const templatePath = join(repoScriptRoot, "src", "prompts", "naming-agent.md");
  if (existsSync(templatePath)) template = readFileSync(templatePath, "utf8");
  return `${template}\n\nContext JSON:\n${JSON.stringify(
    {
      repoRoot,
      repoName: basename(repoRoot),
      suggestedName: requestedName,
      parentPrompt,
      agentPrompt,
      existingWorktrees: listWorktreeBasenames(repoRoot),
    },
    null,
    2,
  )}\n\nReturn only the JSON object.`;
}

function parseFirstJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function createWorktree(repoRoot, worktreePath, branchName) {
  if (existsSync(worktreePath)) throw new Error(`Worktree path already exists: ${worktreePath}`);
  const result = spawnSync("git", ["-C", repoRoot, "worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
  }
}

function dedupeWorktreeName(worktreeBase, baseName, repoRoot) {
  const existing = new Set(listWorktreeBasenames(repoRoot));
  let candidate = baseName;
  let suffix = 2;
  while (existing.has(candidate) || existsSync(join(worktreeBase, candidate))) {
    candidate = `${baseName}-${suffix++}`;
  }
  return candidate;
}

function listWorktreeBasenames(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => basename(line.slice("worktree ".length).trim()))
    .filter(Boolean);
}

function dedupeBranchName(repoRoot, baseName) {
  let candidate = baseName;
  let suffix = 2;
  while (branchExists(repoRoot, candidate)) candidate = `${baseName}-${suffix++}`;
  return candidate;
}

function branchExists(repoRoot, branchName) {
  const result = spawnSync("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
  return result.status === 0;
}

function resolveRepoRoot(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) return resolve(result.stdout.trim());
  return resolve(cwd);
}

function assertGitRepository(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `workspaceMode=worktree requires a git repository, but ${repoRoot} is not inside one. ` +
        "Pass launch_parallel_agents.repoRoot pointing at a git repository or use workspaceMode='current'.",
    );
  }
}

function resolveAccessMode(input, workspaceMode) {
  const defaultMode = workspaceMode === "current" ? "read_only" : "write";
  const mode = String(input ?? defaultMode);
  if (!VALID_ACCESS_MODES.has(mode)) throw new Error(`Invalid access mode: ${mode}`);
  return mode;
}

function sanitizeSlug(input, fallback) {
  const sanitized = String(input ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
  return sanitized || fallback;
}

function sanitizeBranchName(input, fallback) {
  const sanitized = sanitizeSlug(input, fallback).replace(/\.lock$/u, "").replace(/\.\./gu, "-");
  const result = spawnSync("git", ["check-ref-format", "--branch", sanitized], { encoding: "utf8" });
  return result.status === 0 ? sanitized : sanitizeSlug(fallback, "parallel-agent");
}

function safeDisplayName(input) {
  return String(input ?? "agent").trim().replace(/\s+/g, " ").slice(0, 80) || "agent";
}

function dedupeSlug(base, used) {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function toStartResult(row) {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    pid: row.pid,
    workspaceMode: row.workspace_mode,
    accessMode: row.access_mode,
    cwd: row.cwd,
    provider: row.provider,
    model: row.model,
    thinking: row.thinking,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    sessionId: row.session_id,
    sessionFile: row.session_file,
    status: row.status,
  };
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

function required(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === "") throw new Error(`Missing --${key}`);
  return String(value);
}

function optionalString(value) {
  if (value === undefined || value === null || value === true || value === "") return undefined;
  return String(value);
}

function waitForResultFile(path, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const interval = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(interval);
        try {
          const result = readJsonFile(path);
          rmSync(path, { force: true });
          resolvePromise(result);
        } catch (error) {
          rejectPromise(error);
        }
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        rejectPromise(new Error(`Timed out waiting for supervisor result file: ${path}`));
      }
    }, 100);
  });
}

function writeResult(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
  });
}

function appendLog(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, { flag: "a" });
}

function appendEventSafe(db, agentId, eventType, payload) {
  try {
    appendEvent(db, { agentId, eventType, payloadJson: truncate(JSON.stringify(payload), MAX_EVENT_PAYLOAD) });
  } catch {}
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack,
  };
}
