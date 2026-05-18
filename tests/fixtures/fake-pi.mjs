#!/usr/bin/env node

// Deterministic stand-in for the optional naming prompt. SDK behavior is faked
// inside scripts/lib/start-agent.mjs when PI_PARALLEL_AGENTS_FAKE_SDK=1 or when
// the requested model id starts with "fake".
process.stdout.write(JSON.stringify({ displayName: "fake", worktreeName: "agent-fake", branchName: "agent-fake" }) + "\n");
