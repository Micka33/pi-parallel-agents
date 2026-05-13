import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { errorMessage } from "../util/errors.js";

export interface ScriptResult<T> {
  stdout: string;
  stderr: string;
  json: T;
}

export interface RunScriptOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function runJsonScript<T>(scriptPath: string, args: string[], options: RunScriptOptions = {}): Promise<ScriptResult<T>> {
  mkdirSync(dirname(scriptPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          settled = true;
          child.kill("SIGTERM");
          reject(new Error(`Script timed out after ${options.timeoutMs}ms: ${scriptPath}`));
        }, options.timeoutMs)
      : undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Script failed (${code ?? signal}): ${scriptPath}\n${stderr || stdout}`));
        return;
      }
      try {
        resolve({ stdout, stderr, json: JSON.parse(stdout) as T });
      } catch (error) {
        reject(new Error(`Script did not return JSON: ${scriptPath}: ${errorMessage(error)}\n${stdout}`));
      }
    });
  });
}
