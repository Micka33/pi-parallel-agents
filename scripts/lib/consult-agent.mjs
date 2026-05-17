#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { getAgent, openStateDb } from "./state-db.mjs";

const DEFAULT_THINKING = "xhigh";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SAFE_TIMEOUT_MS = 30_000;
const MAX_QUESTION_BYTES = 64 * 1024;
const READ_ONLY_TOOLS = "read,grep,find,ls";

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const stateDb = resolve(required(options, "state-db"));
  const agentId = required(options, "agent-id");
  const question = required(options, "question");
  validateQuestion(question);

  const timeoutMs = numberOption(options, "timeout-ms", DEFAULT_TIMEOUT_MS);
  const safeTimeoutMs = numberOption(options, "safe-timeout-ms", DEFAULT_SAFE_TIMEOUT_MS);
  const thinking = String(options.thinking ?? DEFAULT_THINKING);
  const debug = Boolean(options.debug);

  const db = openStateDb(stateDb);
  let agent;
  try {
    agent = await waitForSafeAgent(db, agentId, safeTimeoutMs);
  } finally {
    db.close();
  }

  if (agent.workspace_mode !== "worktree") {
    throw new Error(`mode=consult requires workspaceMode=worktree; agent ${agentId} uses ${agent.workspace_mode}`);
  }
  if (!agent.worktree_path) throw new Error(`Agent ${agentId} has no source worktree path`);
  if (agent.status === "cleaned") throw new Error(`Cannot consult cleaned agent: ${agentId}`);

  const repoRoot = resolve(String(agent.repo_root));
  const sourceCwd = resolve(String(agent.cwd || agent.worktree_path));
  const consultId = `${sanitizeSlug(agentId, "agent")}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const worktreeBase = join(dirname(repoRoot), "pi");
  const worktreePath = join(worktreeBase, `consult-${consultId}`);
  const branchName = sanitizeBranchName(`consult-${consultId}`);
  const cleanup = { worktreeRemoved: false, branchRemoved: false, sessionRemoved: false, kept: debug };
  let tempSessionFile = null;
  let output = null;

  try {
    mkdirSync(worktreeBase, { recursive: true });
    const startPoint = resolveSourceStartPoint(repoRoot, sourceCwd, agent);
    createConsultWorktree(repoRoot, worktreePath, branchName, startPoint);
    tempSessionFile = cloneSessionFile(agent, worktreePath, consultId);

    const sourceDirty = isDirty(sourceCwd);
    const prompt = buildConsultPrompt({ agent, question, sourceDirty });
    const rpcResult = await runConsultRpc({
      cwd: worktreePath,
      piBin: String(options["pi-bin"] ?? process.env.PI_PARALLEL_AGENTS_PI_BIN ?? "pi"),
      provider: optionalString(options.provider) ?? agent.provider,
      model: optionalString(options.model) ?? agent.model,
      thinking,
      sessionFile: tempSessionFile,
      prompt,
      timeoutMs,
    });
    output = {
      ok: true,
      action: "consult",
      agentId,
      question,
      answer: rpcResult.answer,
      thinking,
      source: {
        repoRoot,
        worktreePath: agent.worktree_path,
        branchName: agent.branch_name,
        status: agent.status,
        dirty: sourceDirty,
      },
      clone: {
        worktreePath,
        branchName,
        sessionFile: tempSessionFile,
        pid: rpcResult.pid,
      },
      cleanup,
    };
  } finally {
    if (!debug) {
      if (tempSessionFile) {
        rmSync(tempSessionFile, { force: true });
        cleanup.sessionRemoved = true;
      }
      if (existsSync(worktreePath)) {
        removeConsultWorktree(repoRoot, worktreePath);
        cleanup.worktreeRemoved = true;
      }
      if (branchExists(repoRoot, branchName)) {
        deleteBranch(repoRoot, branchName);
        cleanup.branchRemoved = true;
      }
    }
  }

  if (output) process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

async function waitForSafeAgent(db, agentId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const agent = getAgent(db, agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    if (agent.status === "cleaned") throw new Error(`Cannot consult cleaned agent: ${agentId}`);
    if (agent.status === "waiting" || agent.status === "stopped" || agent.status === "done" || agent.status === "crashed") return agent;
    await sleep(100);
  }
  const agent = getAgent(db, agentId);
  throw new Error(`Timed out waiting for safe consult point for ${agentId}; current status is ${agent?.status ?? "unknown"}`);
}

function validateQuestion(question) {
  if (question.includes("\0")) throw new Error("Consult question must not contain NUL bytes");
  if (Buffer.byteLength(question, "utf8") > MAX_QUESTION_BYTES) {
    throw new Error(`Consult question is too large; max ${MAX_QUESTION_BYTES} bytes`);
  }
}

function resolveSourceStartPoint(repoRoot, sourceCwd, agent) {
  const ref = agent.branch_name || "HEAD";
  const cwd = agent.branch_name ? repoRoot : sourceCwd;
  const result = spawnSync("git", ["-C", cwd, "rev-parse", ref], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to resolve source start point ${ref}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function createConsultWorktree(repoRoot, worktreePath, branchName, startPoint) {
  const result = spawnSync("git", ["-C", repoRoot, "worktree", "add", "-b", branchName, worktreePath, startPoint], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
}

function removeConsultWorktree(repoRoot, worktreePath) {
  const result = spawnSync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreePath], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git worktree remove failed: ${result.stderr || result.stdout}`);
}

function deleteBranch(repoRoot, branchName) {
  const result = spawnSync("git", ["-C", repoRoot, "branch", "-D", branchName], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git branch delete failed: ${result.stderr || result.stdout}`);
}

function branchExists(repoRoot, branchName) {
  const result = spawnSync("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
  return result.status === 0;
}

function cloneSessionFile(agent, worktreePath, consultId) {
  if (!agent.session_file || !existsSync(agent.session_file)) return null;
  const sessionDir = join(worktreePath, ".pi", "parallel-agents", "consult-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const target = join(sessionDir, `${consultId}.jsonl`);
  copyFileSync(agent.session_file, target);
  return target;
}

function isDirty(cwd) {
  const result = spawnSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function buildConsultPrompt({ agent, question, sourceDirty }) {
  return [
    "You are a temporary isolated consultation clone for a parallel Pi child agent.",
    "Answer the parent question without steering or modifying the source child agent.",
    "Do not modify files. Use read-only inspection tools only unless the parent explicitly asks otherwise.",
    "Return a concise answer with evidence and caveats.",
    "",
    "Source agent:",
    JSON.stringify(
      {
        agentId: agent.agent_id,
        displayName: agent.display_name,
        repoRoot: agent.repo_root,
        sourceWorktree: agent.worktree_path,
        branchName: agent.branch_name,
        model: agent.model,
        thinking: agent.thinking,
        sourceDirty,
      },
      null,
      2,
    ),
    "",
    "Parent question:",
    question,
  ].join("\n");
}

async function runConsultRpc({ cwd, piBin, provider, model, thinking, sessionFile, prompt, timeoutMs }) {
  const args = ["--mode", "rpc"];
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (sessionFile) args.push("--session", sessionFile);
  args.push("--tools", READ_ONLY_TOOLS);

  const child = spawn(piBin, args, {
    cwd,
    env: { ...process.env, PI_PARALLEL_AGENTS_CONSULT: "1" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let lastAnswer = "";
  let settled = false;
  const promptId = `consult-${process.pid}-${Date.now()}`;

  const cleanupAndReject = (reject, error) => {
    if (settled) return;
    settled = true;
    stopChild(child);
    reject(error);
  };

  const final = new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanupAndReject(rejectPromise, new Error(`Consult timed out after ${timeoutMs}ms${stderr ? `: ${truncate(stderr, 1000)}` : ""}`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      cleanupAndReject(rejectPromise, error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timeout);
      if (lastAnswer) {
        settled = true;
        resolvePromise({ answer: lastAnswer, pid: child.pid ?? null });
        return;
      }
      cleanupAndReject(rejectPromise, new Error(`Pi RPC consult exited before an answer (code=${code ?? "null"}, signal=${signal ?? "null"})${stderr ? `: ${truncate(stderr, 1000)}` : ""}`));
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    attachJsonlReader(child.stdout, (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.type === "response" && message.id === promptId && message.success === false) {
        clearTimeout(timeout);
        cleanupAndReject(rejectPromise, new Error(message.error ?? "Consult prompt failed"));
        return;
      }

      if (message.type === "turn_end") {
        const text = extractAssistantText(message.message ?? message);
        if (text) {
          lastAnswer = text;
          clearTimeout(timeout);
          settled = true;
          terminateChild(child).then(
            () => resolvePromise({ answer: text, pid: child.pid ?? null }),
            rejectPromise,
          );
        }
        return;
      }

      if (message.type === "agent_end") {
        const text = extractAssistantText(message.message ?? message.messages ?? message) || lastAnswer;
        clearTimeout(timeout);
        if (!text) {
          cleanupAndReject(rejectPromise, new Error("Consult finished without assistant text"));
          return;
        }
        settled = true;
        terminateChild(child).then(
          () => resolvePromise({ answer: text, pid: child.pid ?? null }),
          rejectPromise,
        );
      }
    });
  });

  child.stdin.write(`${JSON.stringify({ id: promptId, type: "prompt", message: prompt })}\n`);
  return final;
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

function extractAssistantText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractAssistantText).filter(Boolean).join("\n").trim();
  if (typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return value.content.map(extractAssistantText).filter(Boolean).join("\n").trim();
  if (Array.isArray(value.messages)) return value.messages.map(extractAssistantText).filter(Boolean).join("\n").trim();
  if (value.message) return extractAssistantText(value.message);
  return "";
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }, 1000).unref?.();
}

function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const done = () => resolvePromise();
    child.once("close", done);
    stopChild(child);
    setTimeout(done, 1500).unref?.();
  });
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

function optionalString(value) {
  if (value === undefined || value === null || value === true || value === "") return undefined;
  return String(value);
}

function numberOption(options, key, fallback) {
  const raw = options[key];
  if (raw === undefined || raw === true || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --${key}: ${raw}`);
  return value;
}

function sanitizeSlug(input, fallback) {
  const value = String(input ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
  return value || fallback;
}

function sanitizeBranchName(input) {
  const fallback = sanitizeSlug(input, "consult-agent").replace(/\.lock$/u, "").replace(/\.\./gu, "-");
  const result = spawnSync("git", ["check-ref-format", "--branch", fallback], { encoding: "utf8" });
  return result.status === 0 ? fallback : `consult-${Date.now()}`;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function truncate(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
