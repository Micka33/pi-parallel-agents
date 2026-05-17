#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const threshold = "100";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function testFiles(dir = join(root, "tests")) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return testFiles(path);
      if (entry.isFile() && entry.name.endsWith(".test.mjs")) return [path];
      return [];
    })
    .sort();
}

console.log("Building before coverage...");
run("npm", ["run", "build"]);

const tests = testFiles();
if (tests.length === 0) {
  console.error("No test files found in tests/**/*.test.mjs");
  process.exit(1);
}

console.log(`Running coverage with ${threshold}% thresholds for lines, branches, and functions...`);
run(process.execPath, [
  "--test",
  "--experimental-test-coverage",
  `--test-coverage-lines=${threshold}`,
  `--test-coverage-branches=${threshold}`,
  `--test-coverage-functions=${threshold}`,
  ...tests,
]);
