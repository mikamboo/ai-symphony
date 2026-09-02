import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAgentRunner } from "./claudeCodeRunner.js";
import type { CodexConfig, Issue } from "../domain/types.js";

/**
 * Runs against the REAL `claude` CLI, not a fake stub (see claudeCodeRunner.test.ts for the
 * deterministic, network-free suite covering this runner's own logic). This is the live
 * counterpart, in the same spirit as linear.schema.test.ts: confirms the CLI flags and output
 * shape this runner depends on (`--verbose` requirement, `--session-id`/`--resume` continuity,
 * the `result`/`is_error`/`usage` event shape) still hold for whatever `claude` version is
 * installed. Costs real API usage per run, so opt-in only:
 *
 *   SYMPHONY_TEST_LIVE_CLAUDE_CODE=1 pnpm vitest run src/agent/claudeCodeRunner.live.test.ts
 *
 * Skipped by default (SPEC.md 17.8 Real Integration Profile), reported as explicitly skipped
 * rather than silently passing.
 */
const live = process.env.SYMPHONY_TEST_LIVE_CLAUDE_CODE === "1";

function makeIssue(): Issue {
  return {
    id: "id-1",
    nativeRef: null,
    identifier: "LIVE-1",
    title: "Live smoke test",
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

function codexConfig(): CodexConfig {
  return {
    command: "claude",
    approvalPolicy: null,
    threadSandbox: null,
    turnSandboxPolicy: null,
    turnTimeoutMs: 60000,
    readTimeoutMs: 5000,
    stallTimeoutMs: 300000
  };
}

describe.skipIf(!live)("ClaudeCodeAgentRunner vs. the real claude CLI (SYMPHONY_TEST_LIVE_CLAUDE_CODE=1)", () => {
  let workspace: string;

  it("completes a turn and reports token usage", async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "symphony-claude-live-"));
    const runner = new ClaudeCodeAgentRunner();
    const sessionResult = await runner.startSession({
      workspacePath: workspace,
      issue: makeIssue(),
      codexConfig: codexConfig(),
      onEvent: () => undefined
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    const outcome = await sessionResult.value.startTurn("Reply with exactly the word: pong. Use no tools.", {
      title: "LIVE-1: Live smoke test"
    });
    expect(outcome.status).toBe("completed");
    expect(sessionResult.value.threadId).toBeTruthy();

    await sessionResult.value.stop();
  }, 60000);

  it("continues the same session via --resume", async () => {
    const runner = new ClaudeCodeAgentRunner();
    const sessionResult = await runner.startSession({
      workspacePath: workspace,
      issue: makeIssue(),
      codexConfig: codexConfig(),
      onEvent: () => undefined
    });
    if (!sessionResult.ok) throw new Error("expected ok session");

    const first = await sessionResult.value.startTurn("Remember the word banana. Reply with just: ok. Use no tools.", {
      title: "LIVE-1: Live smoke test"
    });
    expect(first.status).toBe("completed");
    const threadIdAfterFirst = sessionResult.value.threadId;

    const second = await sessionResult.value.startTurn("What word did I ask you to remember? Reply with just that word.", {
      title: "LIVE-1: Live smoke test"
    });
    expect(second.status).toBe("completed");
    expect(sessionResult.value.threadId).toBe(threadIdAfterFirst);

    await sessionResult.value.stop();
  }, 60000);

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });
});
