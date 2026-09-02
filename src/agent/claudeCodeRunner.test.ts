import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAgentRunner } from "./claudeCodeRunner.js";
import type { AgentRuntimeEvent } from "./runner.js";
import type { CodexConfig, Issue } from "../domain/types.js";

/**
 * These tests run against a fake `claude` binary (a tiny Node script), not the real Claude Code
 * CLI, so they're deterministic and free to run in CI. They cover argv construction, event
 * parsing, and error handling — the parts under this repo's control. Whether the *real* `claude`
 * CLI still behaves the way this runner assumes (flags, event shapes) is a live-only concern; see
 * the class-level doc comment on claudeCodeRunner.ts for what was directly verified and when.
 */

const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("1.0.0 (Fake Claude)");
  process.exit(0);
}

const argvLogPath = process.env.FAKE_CLAUDE_ARGV_LOG;
if (argvLogPath) {
  const entry = { argv: args, hadSecret: process.env.SYMPHONY_TEST_SECRET !== undefined };
  const existing = fs.existsSync(argvLogPath) ? JSON.parse(fs.readFileSync(argvLogPath, "utf8")) : [];
  existing.push(entry);
  fs.writeFileSync(argvLogPath, JSON.stringify(existing));
}

const idFlagIndex = args.indexOf("--session-id") !== -1 ? args.indexOf("--session-id") : args.indexOf("--resume");
const sessionId = idFlagIndex !== -1 ? args[idFlagIndex + 1] : "fallback-session-id";

const scenario = process.env.FAKE_CLAUDE_SCENARIO || "success";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

if (scenario === "crash") {
  process.exit(1);
} else if (scenario === "hang") {
  setInterval(() => {}, 1000);
} else if (scenario === "no_result") {
  emit({ type: "system", subtype: "init", session_id: sessionId });
  process.exit(0);
} else {
  emit({ type: "system", subtype: "init", session_id: sessionId });
  if (scenario === "malformed") {
    process.stdout.write("not valid json\\n");
  }
  if (scenario === "error") {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 } });
  } else {
    emit({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sessionId, usage: { input_tokens: 3, output_tokens: 7 } });
  }
  process.exit(0);
}
`;

function makeIssue(): Issue {
  return {
    id: "id-1",
    nativeRef: null,
    identifier: "ENG-1",
    title: "Do the thing",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: null,
    updatedAt: null
  };
}

function codexConfig(overrides: Partial<CodexConfig> = {}, claudeBinary?: string): CodexConfig {
  return {
    command: claudeBinary ?? "claude",
    approvalPolicy: null,
    threadSandbox: null,
    turnSandboxPolicy: null,
    turnTimeoutMs: 5000,
    readTimeoutMs: 5000,
    stallTimeoutMs: 300000,
    ...overrides
  };
}

let tempDir: string;
let claudeBinaryPath: string;
let argvLogPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "fake-claude-"));
  claudeBinaryPath = path.join(tempDir, "claude");
  argvLogPath = path.join(tempDir, "argv-log.json");
  await writeFile(claudeBinaryPath, FAKE_CLAUDE_SOURCE);
  await chmod(claudeBinaryPath, 0o755);
  process.env.FAKE_CLAUDE_ARGV_LOG = argvLogPath;
});

afterEach(async () => {
  delete process.env.FAKE_CLAUDE_ARGV_LOG;
  delete process.env.FAKE_CLAUDE_SCENARIO;
  delete process.env.SYMPHONY_TEST_SECRET;
  await rm(tempDir, { recursive: true, force: true });
});

async function readArgvLog(): Promise<{ argv: string[]; hadSecret: boolean }[]> {
  return JSON.parse(await readFile(argvLogPath, "utf8"));
}

describe("ClaudeCodeAgentRunner", () => {
  it("rejects a codex.command containing whitespace without spawning anything", async () => {
    const runner = new ClaudeCodeAgentRunner();
    const result = await runner.startSession({
      workspacePath: tempDir,
      issue: makeIssue(),
      codexConfig: codexConfig({}, "codex app-server"),
      onEvent: () => undefined
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("codex_not_found");
  });

  it("fails startSession when the binary cannot be executed", async () => {
    const runner = new ClaudeCodeAgentRunner();
    const result = await runner.startSession({
      workspacePath: tempDir,
      issue: makeIssue(),
      codexConfig: codexConfig({}, path.join(tempDir, "does-not-exist")),
      onEvent: () => undefined
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("codex_not_found");
  });

  it("runs a successful turn, reports completed, and forwards token usage", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "success";
    const events: AgentRuntimeEvent[] = [];
    const runner = new ClaudeCodeAgentRunner();
    const sessionResult = await runner.startSession({
      workspacePath: tempDir,
      issue: makeIssue(),
      codexConfig: codexConfig({}, claudeBinaryPath),
      onEvent: (e) => events.push(e)
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    const outcome = await sessionResult.value.startTurn("do the work", { title: "ENG-1: Do the thing" });
    expect(outcome).toEqual({ status: "completed" });
    expect(sessionResult.value.threadId).toBeTruthy();

    const usageEvent = events.find((e) => e.event === "usage");
    expect(usageEvent?.usage).toEqual({ inputTokens: 3, outputTokens: 7, totalTokens: 10, absolute: false });

    await sessionResult.value.stop();
  });

  it("uses --session-id on the first turn and --resume with the same id on the second", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "success";
    const runner = new ClaudeCodeAgentRunner();
    const sessionResult = await runner.startSession({
      workspacePath: tempDir,
      issue: makeIssue(),
      codexConfig: codexConfig({}, claudeBinaryPath),
      onEvent: () => undefined
    });
    if (!sessionResult.ok) throw new Error("expected ok session");

    await sessionResult.value.startTurn("first prompt", { title: "t" });
    await sessionResult.value.startTurn("continuation prompt", { title: "t" });
    await sessionResult.value.stop();

    const log = await readArgvLog();
    expect(log).toHaveLength(2);

    const firstArgv = log[0]?.argv ?? [];
    expect(firstArgv).toContain("--session-id");
    expect(firstArgv).not.toContain("--resume");

    const secondArgv = log[1]?.argv ?? [];
    expect(secondArgv).toContain("--resume");
    expect(secondArgv).not.toContain("--session-id");

    const firstId = firstArgv[firstArgv.indexOf("--session-id") + 1];
    const secondId = secondArgv[secondArgv.indexOf("--resume") + 1];
    expect(secondId).toBe(firstId);
  });

  it("reports failed when the CLI signals is_error: true", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "error";
    const runner = new ClaudeCodeAgentRunner();
    const sessionResult = await runner.startSession({
      workspacePath: tempDir,
      issue: makeIssue(),
      codexConfig: codexConfig({}, claudeBinaryPath),
      onEvent: () => undefined
    });
    if (!sessionResult.ok) throw new Error("expected ok session");

    const outcome = await sessionResult.value.startTurn("prompt", { title: "t" });
    expect(outcome).toEqual({ status: "failed", error: "boom" });
    await sessionResult.value.stop();
  });

  it("reports failed when the process exits without ever emitting a result", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "no_result";
    const runner = new ClaudeCodeAgentRunner();
    const sessionResult = await runner.startSession({
      workspacePath: tempDir,
      issue: makeIssue(),
      codexConfig: codexConfig({}, claudeBinaryPath),
      onEvent: () => undefined
    });
    if (!sessionResult.ok) throw new Error("expected ok session");

    const outcome = await sessionResult.value.startTurn("prompt", { title: "t" });
    expect(outcome.status).toBe("failed");
    await sessionResult.value.stop();
  });

  it("emits a malformed event for a non-JSON line but still processes the following result line", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "malformed";
    const events: AgentRuntimeEvent[] = [];
    const runner = new ClaudeCodeAgentRunner();
    const sessionResult = await runner.startSession({
      workspacePath: tempDir,
      issue: makeIssue(),
      codexConfig: codexConfig({}, claudeBinaryPath),
      onEvent: (e) => events.push(e)
    });
    if (!sessionResult.ok) throw new Error("expected ok session");

    const outcome = await sessionResult.value.startTurn("prompt", { title: "t" });
    expect(outcome).toEqual({ status: "completed" });
    expect(events.some((e) => e.event === "malformed")).toBe(true);
    await sessionResult.value.stop();
  });

  it("strips configured secret environment variables from the child process", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "success";
    process.env.SYMPHONY_TEST_SECRET = "super-secret-value";
    const runner = new ClaudeCodeAgentRunner({ secretEnvNames: ["SYMPHONY_TEST_SECRET"] });
    const sessionResult = await runner.startSession({
      workspacePath: tempDir,
      issue: makeIssue(),
      codexConfig: codexConfig({}, claudeBinaryPath),
      onEvent: () => undefined
    });
    if (!sessionResult.ok) throw new Error("expected ok session");

    await sessionResult.value.startTurn("prompt", { title: "t" });
    await sessionResult.value.stop();

    const log = await readArgvLog();
    expect(log[0]?.hadSecret).toBe(false);
  });

  it("falls back to the default permission mode for an unrecognized configured value", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "success";
    const runner = new ClaudeCodeAgentRunner({ permissionMode: "not-a-real-mode" });
    const sessionResult = await runner.startSession({
      workspacePath: tempDir,
      issue: makeIssue(),
      codexConfig: codexConfig({}, claudeBinaryPath),
      onEvent: () => undefined
    });
    if (!sessionResult.ok) throw new Error("expected ok session");

    await sessionResult.value.startTurn("prompt", { title: "t" });
    await sessionResult.value.stop();

    const log = await readArgvLog();
    const argv = log[0]?.argv ?? [];
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  it("times out a turn that produces no output within turn_timeout_ms", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "hang";
    const runner = new ClaudeCodeAgentRunner();
    const sessionResult = await runner.startSession({
      workspacePath: tempDir,
      issue: makeIssue(),
      codexConfig: codexConfig({ turnTimeoutMs: 200 }, claudeBinaryPath),
      onEvent: () => undefined
    });
    if (!sessionResult.ok) throw new Error("expected ok session");

    const outcome = await sessionResult.value.startTurn("prompt", { title: "t" });
    expect(outcome.status).toBe("timeout");
    await sessionResult.value.stop();
  });
});
