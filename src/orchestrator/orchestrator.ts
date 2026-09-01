import path from "node:path";
import { buildServiceConfig } from "../config/resolve.js";
import { validateDispatchPreflight } from "../config/validate.js";
import type { ServiceConfig, Issue, OrchestratorState, LiveSession, WorkflowDefinition } from "../domain/types.js";
import { normalizeState } from "../domain/types.js";
import { ConfigError, WorkflowError } from "../domain/errors.js";
import type { Logger } from "../logging/logger.js";
import { loadWorkflowFile } from "../workflow/loader.js";
import { watchWorkflowFile, type WorkflowWatchHandle } from "../workflow/watcher.js";
import { WorkspaceManager } from "../workspace/manager.js";
import type { TrackerAdapter } from "../tracker/adapter.js";
import { issueRoutable } from "../tracker/adapter.js";
import type { AgentRunner, AgentRuntimeEvent } from "../agent/runner.js";
import { buildContinuationGuidance, renderPrompt } from "../prompt/render.js";
import { CONTINUATION_RETRY_DELAY_MS, failureBackoffMs, nextAttemptFrom } from "./backoff.js";
import { availableStateSlots, isActiveState, isTerminalState, noAvailableSlots, shouldDispatch, sortForDispatch } from "./selection.js";
import { buildSnapshot, type RuntimeSnapshot } from "./snapshot.js";

function emptyLiveSession(): LiveSession {
  return {
    sessionId: null,
    threadId: null,
    turnId: null,
    codexAppServerPid: null,
    lastCodexEvent: null,
    lastCodexTimestamp: null,
    lastCodexMessage: null,
    codexInputTokens: 0,
    codexOutputTokens: 0,
    codexTotalTokens: 0,
    lastReportedInputTokens: 0,
    lastReportedOutputTokens: 0,
    lastReportedTotalTokens: 0,
    turnCount: 0
  };
}

function initialState(config: ServiceConfig): OrchestratorState {
  return {
    pollIntervalMs: config.polling.intervalMs,
    maxConcurrentAgents: config.agent.maxConcurrentAgents,
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    codexTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    codexRateLimits: null
  };
}

export interface OrchestratorOptions {
  workflowPath: string;
  workflow: WorkflowDefinition;
  config: ServiceConfig;
  tracker: TrackerAdapter;
  agentRunner: AgentRunner;
  logger: Logger;
  onSnapshot?: (snapshot: RuntimeSnapshot) => void;
}

type WorkerExitReason = "normal" | "abnormal";

/**
 * The Symphony orchestrator (SPEC.md Section 7, 8, 16): owns the poll tick and the single
 * authoritative in-memory runtime state, and is the only component that mutates it.
 */
export class Orchestrator {
  private workflowPath: string;
  private currentWorkflow: WorkflowDefinition;
  private currentConfig: ServiceConfig;
  private readonly tracker: TrackerAdapter;
  private readonly agentRunner: AgentRunner;
  private readonly logger: Logger;
  private readonly onSnapshot?: (snapshot: RuntimeSnapshot) => void;

  private workspaceManager: WorkspaceManager;
  private state: OrchestratorState;
  private workflowWatch: WorkflowWatchHandle | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: OrchestratorOptions) {
    this.workflowPath = options.workflowPath;
    this.currentWorkflow = options.workflow;
    this.currentConfig = options.config;
    this.tracker = options.tracker;
    this.agentRunner = options.agentRunner;
    this.logger = options.logger;
    this.onSnapshot = options.onSnapshot;

    this.workspaceManager = new WorkspaceManager(this.currentConfig, this.logger);
    this.state = initialState(this.currentConfig);
  }

  getSnapshot(): RuntimeSnapshot {
    return buildSnapshot(this.state);
  }

  /** Service startup (SPEC.md 16.1). Throws if startup validation fails. */
  async start(): Promise<void> {
    this.workflowWatch = watchWorkflowFile(this.workflowPath, () => {
      void this.handleWorkflowChange();
    });

    const preflight = this.validatePreflight();
    if (!preflight.ok) {
      this.logger.error("startup.validation_failed", { error: preflight.error.message });
      throw preflight.error;
    }

    await this.startupTerminalWorkspaceCleanup();
    this.scheduleTick(0);
    this.logger.info("service.started", { poll_interval_ms: this.currentConfig.polling.intervalMs });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const entry of this.state.retryAttempts.values()) clearTimeout(entry.timerHandle);
    if (this.workflowWatch) await this.workflowWatch.close();

    const stops = [...this.state.running.values()].map((entry) => {
      entry.abort.abort();
      return entry.agentSession?.stop() ?? Promise.resolve();
    });
    await Promise.allSettled(stops);
  }

  private validatePreflight() {
    return validateDispatchPreflight(this.currentConfig, {
      isTrackerConfigValid: (config) =>
        config.tracker.kind === this.tracker.kind
          ? { ok: true }
          : {
              ok: false,
              message: `tracker.kind changed from '${this.tracker.kind}' to '${config.tracker.kind}'; restart is required to switch tracker adapters`
            }
    });
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    this.tickTimer = setTimeout(() => {
      void this.onTick();
    }, delayMs);
    this.tickTimer.unref?.();
  }

  private notifyObservers(): void {
    this.onSnapshot?.(this.getSnapshot());
  }

  private async handleWorkflowChange(): Promise<void> {
    try {
      const workflow = await loadWorkflowFile(this.workflowPath);
      const config = buildServiceConfig(workflow.config, path.dirname(this.workflowPath));
      this.currentWorkflow = workflow;
      this.currentConfig = config;
      this.workspaceManager = new WorkspaceManager(config, this.logger);
      this.state.pollIntervalMs = config.polling.intervalMs;
      this.state.maxConcurrentAgents = config.agent.maxConcurrentAgents;
      this.logger.info("workflow.reloaded", { workflow_path: this.workflowPath });
    } catch (cause) {
      // Invalid reloads MUST NOT crash the service; keep the last known good config (SPEC.md 6.2).
      const category = cause instanceof WorkflowError || cause instanceof ConfigError ? cause.category : "unknown";
      this.logger.error("workflow.reload_failed", { error: String(cause), category });
    }
  }

  private async startupTerminalWorkspaceCleanup(): Promise<void> {
    const result = await this.tracker.fetchIssuesByStates(this.currentConfig.tracker.terminalStates);
    if (!result.ok) {
      this.logger.warn("startup.terminal_cleanup_failed", { error: result.error.message });
      return;
    }
    for (const issue of result.value) {
      try {
        await this.workspaceManager.remove(issue.identifier);
      } catch (cause) {
        this.logger.warn("workspace.cleanup_failed", { issue_identifier: issue.identifier, error: String(cause) });
      }
    }
  }

  /** Poll-and-dispatch tick (SPEC.md 16.2). */
  private async onTick(): Promise<void> {
    if (this.stopped) return;

    await this.reconcileRunningIssues();

    const preflight = this.validatePreflight();
    if (!preflight.ok) {
      this.logger.error("dispatch.validation_failed", { error: preflight.error.message });
      this.notifyObservers();
      this.scheduleTick(this.state.pollIntervalMs);
      return;
    }

    const candidates = await this.tracker.fetchIssuesByStates(this.currentConfig.tracker.activeStates);
    if (!candidates.ok) {
      this.logger.error("dispatch.candidate_fetch_failed", { error: candidates.error.message });
      this.notifyObservers();
      this.scheduleTick(this.state.pollIntervalMs);
      return;
    }

    for (const issue of sortForDispatch(candidates.value)) {
      if (noAvailableSlots(this.state, this.currentConfig)) break;
      if (shouldDispatch(issue, this.state, this.currentConfig)) {
        this.dispatchIssue(issue, null);
      }
    }

    this.notifyObservers();
    this.scheduleTick(this.state.pollIntervalMs);
  }

  /** Reconcile active runs (SPEC.md 16.3, 8.5). */
  private async reconcileRunningIssues(): Promise<void> {
    this.reconcileStalledRuns();

    const runningIds = [...this.state.running.keys()];
    if (runningIds.length === 0) return;

    const refreshed = await this.tracker.fetchIssuesByIds(runningIds);
    if (!refreshed.ok) {
      this.logger.debug("reconcile.refresh_failed_keep_running", { error: refreshed.error.message });
      return;
    }

    const refreshedIds = new Set<string>();
    for (const issue of refreshed.value) {
      refreshedIds.add(issue.id);
      if (isTerminalState(this.currentConfig, issue.state)) {
        this.terminateRunning(issue.id, { releaseClaim: true, cleanupWorkspace: true });
      } else if (isActiveState(this.currentConfig, issue.state) && issueRoutable(issue, this.currentConfig.tracker.requiredLabels)) {
        const entry = this.state.running.get(issue.id);
        if (entry) entry.issue = issue;
      } else {
        this.terminateRunning(issue.id, { releaseClaim: true, cleanupWorkspace: false });
      }
    }

    for (const missingId of runningIds) {
      if (!refreshedIds.has(missingId)) {
        this.terminateRunning(missingId, { releaseClaim: true, cleanupWorkspace: false });
      }
    }
  }

  private reconcileStalledRuns(): void {
    const stallTimeoutMs = this.currentConfig.codex.stallTimeoutMs;
    if (stallTimeoutMs <= 0) return;

    const now = Date.now();
    for (const [issueId, entry] of [...this.state.running]) {
      const lastEventMs = entry.session.lastCodexTimestamp ? Date.parse(entry.session.lastCodexTimestamp) : entry.startedAt;
      if (now - lastEventMs > stallTimeoutMs) {
        this.logger.warn("reconcile.stall_detected", { issue_id: issueId, issue_identifier: entry.identifier });
        this.terminateRunningAndScheduleRetry(issueId, "stall timeout");
      }
    }
  }

  /** Stop a worker and either release its claim (state-driven termination) or... */
  private terminateRunning(issueId: string, opts: { releaseClaim: boolean; cleanupWorkspace: boolean }): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    this.state.running.delete(issueId);
    entry.abort.abort();
    void entry.agentSession?.stop();
    this.state.codexTotals.secondsRunning += (Date.now() - entry.startedAt) / 1000;

    if (opts.releaseClaim) {
      this.state.claimed.delete(issueId);
      const retry = this.state.retryAttempts.get(issueId);
      if (retry) {
        clearTimeout(retry.timerHandle);
        this.state.retryAttempts.delete(issueId);
      }
    }

    if (opts.cleanupWorkspace) {
      this.workspaceManager.remove(entry.identifier).catch((cause) => {
        this.logger.warn("workspace.cleanup_failed", { issue_identifier: entry.identifier, error: String(cause) });
      });
    }
  }

  /** ...or force-kill and reschedule a backoff retry (stall timeout, SPEC.md 7.3). */
  private terminateRunningAndScheduleRetry(issueId: string, error: string): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    this.state.running.delete(issueId);
    entry.abort.abort();
    void entry.agentSession?.stop();
    this.state.codexTotals.secondsRunning += (Date.now() - entry.startedAt) / 1000;

    const nextAttempt = nextAttemptFrom(entry.retryAttempt);
    this.scheduleRetry(issueId, nextAttempt, entry.identifier, error, failureBackoffMs(nextAttempt, this.currentConfig.agent.maxRetryBackoffMs));
  }

  /** Dispatch one issue (SPEC.md 16.4). */
  private dispatchIssue(issue: Issue, attempt: number | null): void {
    const abort = new AbortController();
    this.state.running.set(issue.id, {
      issue,
      identifier: issue.identifier,
      session: emptyLiveSession(),
      retryAttempt: attempt,
      startedAt: Date.now(),
      workspacePath: null,
      abort,
      agentSession: null
    });
    this.state.claimed.add(issue.id);

    const existingRetry = this.state.retryAttempts.get(issue.id);
    if (existingRetry) {
      clearTimeout(existingRetry.timerHandle);
      this.state.retryAttempts.delete(issue.id);
    }

    this.runAgentAttempt(issue, attempt, abort.signal)
      .then((reason) => this.onWorkerExit(issue.id, reason))
      .catch((cause) => {
        this.logger.error("worker.unexpected_error", { issue_id: issue.id, issue_identifier: issue.identifier, error: String(cause) });
        this.onWorkerExit(issue.id, "abnormal", String(cause));
      });
  }

  /** Worker attempt: workspace + prompt + agent turns (SPEC.md 16.5, 7.1). */
  private async runAgentAttempt(issue: Issue, attempt: number | null, signal: AbortSignal): Promise<WorkerExitReason> {
    const config = this.currentConfig;
    const workflow = this.currentWorkflow;
    const log = this.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier });

    const workspace = await this.workspaceManager.createForIssue(issue.identifier).catch((cause) => {
      log.error("workspace.create_failed", { error: String(cause) });
      return null;
    });
    if (!workspace) return "abnormal";

    const runningEntry = this.state.running.get(issue.id);
    if (runningEntry) runningEntry.workspacePath = workspace.path;

    try {
      await this.workspaceManager.runBeforeRun(workspace.path);
    } catch (cause) {
      log.error("hook.before_run_failed", { error: String(cause) });
      await this.workspaceManager.runAfterRun(workspace.path);
      return "abnormal";
    }

    const sessionResult = await this.agentRunner.startSession({
      workspacePath: workspace.path,
      issue,
      codexConfig: config.codex,
      onEvent: (event) => this.onAgentEvent(issue.id, event)
    });
    if (!sessionResult.ok) {
      log.error("agent.session_start_failed", { error: sessionResult.error.message, category: sessionResult.error.category });
      await this.workspaceManager.runAfterRun(workspace.path);
      return "abnormal";
    }

    const session = sessionResult.value;
    if (runningEntry) {
      runningEntry.agentSession = session;
      runningEntry.session.sessionId = session.sessionId;
      runningEntry.session.threadId = session.threadId;
    }

    let currentIssue = issue;
    let outcome: WorkerExitReason = "normal";
    const maxTurns = config.agent.maxTurns;

    for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber++) {
      if (signal.aborted) {
        outcome = "abnormal";
        break;
      }

      let prompt: string;
      try {
        prompt =
          turnNumber === 1
            ? await renderPrompt(workflow.promptTemplate, currentIssue, attempt)
            : buildContinuationGuidance(turnNumber, maxTurns);
      } catch (cause) {
        log.error("prompt.render_failed", { error: String(cause) });
        outcome = "abnormal";
        break;
      }

      const turnResult = await session.startTurn(prompt, { title: `${currentIssue.identifier}: ${currentIssue.title}` });
      if (runningEntry) runningEntry.session.turnCount = turnNumber;

      if (turnResult.status !== "completed") {
        log.warn("agent.turn_not_completed", { status: turnResult.status, error: turnResult.error });
        outcome = "abnormal";
        break;
      }

      const refreshed = await this.tracker.fetchIssuesByIds([currentIssue.id]);
      if (!refreshed.ok) {
        log.error("issue.refresh_failed", { error: refreshed.error.message });
        outcome = "abnormal";
        break;
      }
      if (refreshed.value.length === 0) {
        outcome = "normal";
        break;
      }

      currentIssue = refreshed.value[0] as Issue;
      if (runningEntry) runningEntry.issue = currentIssue;

      if (!isActiveState(config, currentIssue.state) || !issueRoutable(currentIssue, config.tracker.requiredLabels)) {
        outcome = "normal";
        break;
      }
      if (turnNumber >= maxTurns) {
        outcome = "normal";
        break;
      }
    }

    await session.stop();
    await this.workspaceManager.runAfterRun(workspace.path);
    return outcome;
  }

  private onAgentEvent(issueId: string, event: AgentRuntimeEvent): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    entry.session.lastCodexEvent = event.event;
    entry.session.lastCodexTimestamp = event.timestamp;
    entry.session.lastCodexMessage = event.payload;
    if (event.codexAppServerPid) entry.session.codexAppServerPid = event.codexAppServerPid;

    if (event.usage) {
      const { inputTokens = 0, outputTokens = 0, totalTokens = 0, absolute } = event.usage;
      if (absolute) {
        // Absolute thread totals: track deltas relative to last reported totals (SPEC.md 13.5).
        const dIn = Math.max(0, inputTokens - entry.session.lastReportedInputTokens);
        const dOut = Math.max(0, outputTokens - entry.session.lastReportedOutputTokens);
        const dTotal = Math.max(0, totalTokens - entry.session.lastReportedTotalTokens);
        entry.session.codexInputTokens += dIn;
        entry.session.codexOutputTokens += dOut;
        entry.session.codexTotalTokens += dTotal;
        this.state.codexTotals.inputTokens += dIn;
        this.state.codexTotals.outputTokens += dOut;
        this.state.codexTotals.totalTokens += dTotal;
        entry.session.lastReportedInputTokens = inputTokens;
        entry.session.lastReportedOutputTokens = outputTokens;
        entry.session.lastReportedTotalTokens = totalTokens;
      }
    }
  }

  /** Worker exit handling (SPEC.md 16.6). */
  private onWorkerExit(issueId: string, reason: WorkerExitReason, error?: string): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return; // Already handled by reconciliation/stall termination.

    this.state.running.delete(issueId);
    this.state.codexTotals.secondsRunning += (Date.now() - entry.startedAt) / 1000;

    if (reason === "normal") {
      this.state.completed.add(issueId);
      this.scheduleRetry(issueId, 1, entry.identifier, null, CONTINUATION_RETRY_DELAY_MS);
    } else {
      const nextAttempt = nextAttemptFrom(entry.retryAttempt);
      this.scheduleRetry(
        issueId,
        nextAttempt,
        entry.identifier,
        error ?? "worker exited abnormally",
        failureBackoffMs(nextAttempt, this.currentConfig.agent.maxRetryBackoffMs)
      );
    }

    this.notifyObservers();
  }

  private scheduleRetry(issueId: string, attempt: number, identifier: string, error: string | null, delayMs: number): void {
    const existing = this.state.retryAttempts.get(issueId);
    if (existing) clearTimeout(existing.timerHandle);

    const timerHandle = setTimeout(() => {
      void this.onRetryTimer(issueId);
    }, delayMs);
    timerHandle.unref?.();

    this.state.retryAttempts.set(issueId, { issueId, identifier, attempt, dueAtMs: Date.now() + delayMs, timerHandle, error });
    this.state.claimed.add(issueId);
  }

  /** Retry timer fired (SPEC.md 16.6, 8.4). */
  private async onRetryTimer(issueId: string): Promise<void> {
    if (this.stopped) return;
    const retryEntry = this.state.retryAttempts.get(issueId);
    if (!retryEntry) return;
    this.state.retryAttempts.delete(issueId);

    const refreshed = await this.tracker.fetchIssuesByIds([issueId]);
    if (!refreshed.ok) {
      this.logger.warn("retry.refresh_failed", { issue_id: issueId, error: refreshed.error.message });
      this.scheduleRetry(
        issueId,
        retryEntry.attempt + 1,
        retryEntry.identifier,
        "retry refresh failed",
        failureBackoffMs(retryEntry.attempt + 1, this.currentConfig.agent.maxRetryBackoffMs)
      );
      return;
    }

    const issue = refreshed.value.find((i) => i.id === issueId) ?? null;
    if (!issue) {
      this.state.claimed.delete(issueId);
      return;
    }

    if (isTerminalState(this.currentConfig, issue.state)) {
      this.state.claimed.delete(issueId);
      try {
        await this.workspaceManager.remove(issue.identifier);
      } catch (cause) {
        this.logger.warn("workspace.cleanup_failed", { issue_identifier: issue.identifier, error: String(cause) });
      }
      return;
    }

    const routableAndActive = isActiveState(this.currentConfig, issue.state) && issueRoutable(issue, this.currentConfig.tracker.requiredLabels);
    if (!routableAndActive) {
      this.state.claimed.delete(issueId);
      return;
    }

    const normalized = normalizeState(issue.state);
    if (noAvailableSlots(this.state, this.currentConfig) || availableStateSlots(this.state, this.currentConfig, normalized) <= 0) {
      this.scheduleRetry(issueId, retryEntry.attempt + 1, issue.identifier, "no available orchestrator slots", CONTINUATION_RETRY_DELAY_MS);
      return;
    }

    this.dispatchIssue(issue, retryEntry.attempt);
  }
}
