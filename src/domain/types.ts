/**
 * Core domain model, per SPEC.md Section 4.
 */

/** Best-effort blocker reference (SPEC.md 4.1.1). */
export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/**
 * Normalized schedulable work item (SPEC.md 4.1.1).
 * `id` is an opaque dispatch identity; it is NOT assumed to be the provider's
 * underlying ticket ID. `native_ref` is opaque, non-secret, provider-owned data.
 */
export interface Issue {
  id: string;
  nativeRef: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  assigneeId: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  dispatchable: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Parsed WORKFLOW.md payload (SPEC.md 4.1.2 / 5.2). */
export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export interface TrackerConfig {
  kind: string;
  provider: Record<string, unknown>;
  requiredLabels: string[];
  activeStates: string[];
  terminalStates: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
}

export interface CodexConfig {
  command: string;
  approvalPolicy: string | null;
  threadSandbox: string | null;
  turnSandboxPolicy: string | null;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

/** Typed runtime view of workflow config (SPEC.md 4.1.3 / 6). */
export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  /** Absolute directory containing the resolved WORKFLOW.md, used for relative path resolution. */
  workflowDir: string;
}

/** Filesystem workspace assigned to one issue (SPEC.md 4.1.4). */
export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export type RunAttemptStatus =
  | "PreparingWorkspace"
  | "BuildingPrompt"
  | "LaunchingAgentProcess"
  | "InitializingSession"
  | "StreamingTurn"
  | "Finishing"
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Stalled"
  | "CanceledByReconciliation";

/** One execution attempt for one issue (SPEC.md 4.1.5). */
export interface RunAttempt {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  startedAt: string;
  status: RunAttemptStatus;
  error?: string;
}

/** State tracked while a coding-agent subprocess is running (SPEC.md 4.1.6). */
export interface LiveSession {
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  codexAppServerPid: string | null;
  lastCodexEvent: string | null;
  lastCodexTimestamp: string | null;
  lastCodexMessage: unknown;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
}

/** Scheduled retry state for an issue (SPEC.md 4.1.7). */
export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timerHandle: NodeJS.Timeout;
  error: string | null;
}

export interface CodexTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

/** A tracked in-flight run (orchestrator "running" map entry). */
export interface RunningEntry {
  issue: Issue;
  identifier: string;
  session: LiveSession;
  retryAttempt: number | null;
  startedAt: number;
  workspacePath: string | null;
  /** Signaled by the orchestrator to ask the worker loop to stop between turns. */
  abort: AbortController;
  /**
   * Live handle to the running agent session, if one has started, so reconciliation/stall
   * handling can force it to stop immediately rather than waiting for the current turn to end
   * cooperatively.
   */
  agentSession: import("../agent/runner.js").AgentSession | null;
}

/** Single authoritative in-memory orchestrator state (SPEC.md 4.1.8). */
export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codexTotals: CodexTotals;
  codexRateLimits: unknown;
}

export function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}
