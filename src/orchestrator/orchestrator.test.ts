import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "./orchestrator.js";
import { buildServiceConfig } from "../config/resolve.js";
import type { Logger } from "../logging/logger.js";
import { MockTrackerAdapter } from "../tracker/mock.js";
import { MockAgentRunner } from "../agent/mockRunner.js";
import { ok } from "../domain/errors.js";
import type { AgentRunner, AgentSession, StartSessionOptions, TurnOutcome } from "../agent/runner.js";
import type { Issue, WorkflowDefinition } from "../domain/types.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger
};
const logger = silentLogger;

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "id-1",
    nativeRef: null,
    identifier: overrides.identifier ?? "ENG-1",
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
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

const workflow: WorkflowDefinition = { config: {}, promptTemplate: "work on {{ issue.identifier }}" };

const tempDirs: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function pathIsGone(p: string): Promise<boolean> {
  try {
    await stat(p);
    return false;
  } catch {
    return true;
  }
}

/** An AgentRunner whose turns never resolve until the test explicitly resolves them. */
class HoldingAgentRunner implements AgentRunner {
  private resolvers: ((outcome: TurnOutcome) => void)[] = [];
  public sessionsStarted = 0;

  async startSession(_options: StartSessionOptions) {
    this.sessionsStarted += 1;
    const session: AgentSession = {
      sessionId: "held-session",
      threadId: "held-thread",
      startTurn: () => new Promise<TurnOutcome>((resolve) => this.resolvers.push(resolve)),
      stop: async () => undefined
    };
    return ok(session);
  }

  resolveOldest(outcome: TurnOutcome): void {
    this.resolvers.shift()?.(outcome);
  }
}

describe("Orchestrator", () => {
  it("is a no-op when there are no running issues to reconcile", async () => {
    const root = await tempRoot();
    const tracker = new MockTrackerAdapter();
    const fetchByIdsSpy = vi.spyOn(tracker, "fetchIssuesByIds");

    const config = buildServiceConfig({ tracker: { kind: "mock", active_states: ["Todo"], terminal_states: ["Done"] }, workspace: { root }, polling: { interval_ms: 200000 } }, root);
    const orchestrator = new Orchestrator({
      workflowPath: path.join(root, "WORKFLOW.md"),
      workflow,
      config,
      tracker,
      agentRunner: new MockAgentRunner(),
      logger
    });

    await orchestrator.start();
    await waitFor(() => fetchByIdsSpy.mock.calls.length >= 0);
    await new Promise((r) => setTimeout(r, 50));

    // No running issues means fetch_issues_by_ids should never be invoked during reconciliation.
    expect(fetchByIdsSpy).not.toHaveBeenCalled();
    await orchestrator.stop();
  });

  it("schedules a short continuation retry (attempt 1) after a normal worker exit", async () => {
    const root = await tempRoot();
    const tracker = new MockTrackerAdapter();
    const issue = makeIssue({ id: "1", identifier: "ENG-1", state: "Todo" });
    tracker.seed([issue]);

    const config = buildServiceConfig(
      { tracker: { kind: "mock", active_states: ["Todo"], terminal_states: ["Done"] }, workspace: { root }, agent: { max_turns: 1 }, polling: { interval_ms: 200000 } },
      root
    );
    const orchestrator = new Orchestrator({
      workflowPath: path.join(root, "WORKFLOW.md"),
      workflow,
      config,
      tracker,
      agentRunner: new MockAgentRunner([{ status: "completed" }]),
      logger
    });

    await orchestrator.start();
    await waitFor(() => orchestrator.getSnapshot().retrying.length > 0);

    const retryRow = orchestrator.getSnapshot().retrying[0];
    expect(retryRow?.attempt).toBe(1);
    expect(retryRow?.error).toBeNull();
    expect((retryRow?.dueAtMs ?? 0) - Date.now()).toBeLessThanOrEqual(1000);

    await orchestrator.stop();
  });

  it("increments retries with backoff after an abnormal worker exit", async () => {
    const root = await tempRoot();
    const tracker = new MockTrackerAdapter();
    const issue = makeIssue({ id: "1", identifier: "ENG-1", state: "Todo" });
    tracker.seed([issue]);

    const config = buildServiceConfig(
      {
        tracker: { kind: "mock", active_states: ["Todo"], terminal_states: ["Done"] },
        workspace: { root },
        agent: { max_retry_backoff_ms: 50 }, // caps min(10000 * 2^0, 50) = 50ms so the test stays fast
        polling: { interval_ms: 200000 }
      },
      root
    );
    const orchestrator = new Orchestrator({
      workflowPath: path.join(root, "WORKFLOW.md"),
      workflow,
      config,
      tracker,
      agentRunner: new MockAgentRunner([{ status: "failed", error: "boom" }]),
      logger
    });

    await orchestrator.start();
    await waitFor(() => orchestrator.getSnapshot().retrying.length > 0);

    const retryRow = orchestrator.getSnapshot().retrying[0];
    expect(retryRow?.attempt).toBe(1);
    expect(retryRow?.error).toBeTruthy();

    await orchestrator.stop();
  });

  it("reconciliation updates, and eventually stops, a running issue as its tracker state changes", async () => {
    const root = await tempRoot();
    const tracker = new MockTrackerAdapter();
    const issue = makeIssue({ id: "1", identifier: "ENG-1", state: "Todo" });
    tracker.seed([issue]);

    const holding = new HoldingAgentRunner();
    const config = buildServiceConfig(
      { tracker: { kind: "mock", active_states: ["Todo", "In Progress"], terminal_states: ["Done"] }, workspace: { root }, polling: { interval_ms: 30 } },
      root
    );
    const orchestrator = new Orchestrator({
      workflowPath: path.join(root, "WORKFLOW.md"),
      workflow,
      config,
      tracker,
      agentRunner: holding,
      logger
    });

    await orchestrator.start();
    await waitFor(() => orchestrator.getSnapshot().running.length === 1);

    // Active-state refresh should update the running entry's snapshot of the issue.
    tracker.upsert({ ...issue, state: "In Progress" });
    await waitFor(() => orchestrator.getSnapshot().running[0]?.state === "In Progress");

    // Transitioning to a terminal state should stop the run and clean up its workspace.
    const workspacePath = path.join(root, "ENG-1");
    await stat(workspacePath); // sanity: workspace exists while running
    tracker.upsert({ ...issue, state: "Done" });
    await waitFor(() => orchestrator.getSnapshot().running.length === 0);
    // Workspace cleanup is fire-and-forget from terminateRunning(), so poll for it rather than
    // asserting the instant the running entry disappears.
    await waitFor(() => pathIsGone(workspacePath));

    await orchestrator.stop();
  });

  it("reconciliation stops a run without cleaning its workspace when the issue becomes non-active but not terminal", async () => {
    const root = await tempRoot();
    const tracker = new MockTrackerAdapter();
    const issue = makeIssue({ id: "1", identifier: "ENG-1", state: "Todo" });
    tracker.seed([issue]);

    const holding = new HoldingAgentRunner();
    const config = buildServiceConfig(
      { tracker: { kind: "mock", active_states: ["Todo"], terminal_states: ["Done"] }, workspace: { root }, polling: { interval_ms: 30 } },
      root
    );
    const orchestrator = new Orchestrator({
      workflowPath: path.join(root, "WORKFLOW.md"),
      workflow,
      config,
      tracker,
      agentRunner: holding,
      logger
    });

    await orchestrator.start();
    await waitFor(() => orchestrator.getSnapshot().running.length === 1);

    const workspacePath = path.join(root, "ENG-1");
    tracker.upsert({ ...issue, state: "Backlog" }); // neither active nor terminal
    await waitFor(() => orchestrator.getSnapshot().running.length === 0);
    await expect(stat(workspacePath)).resolves.toBeTruthy();

    await orchestrator.stop();
  });
});
