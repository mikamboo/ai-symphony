import type { Result, AgentError } from "../domain/errors.js";
import type { CodexConfig, Issue } from "../domain/types.js";

/**
 * Structured runtime event emitted upstream to the orchestrator (SPEC.md 10.4). `event` is one of
 * the SPEC.md-listed enum values (`session_started`, `turn_completed`, `turn_failed`, ...) or an
 * implementation-specific string; the orchestrator only depends on the well-known subset used in
 * {@link TurnOutcome}, everything else is observability.
 */
export interface AgentRuntimeEvent {
  event: string;
  timestamp: string;
  codexAppServerPid?: string | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    /** true if these are absolute thread totals rather than a delta (SPEC.md 13.5). */
    absolute?: boolean;
  };
  payload?: unknown;
}

export type TurnOutcomeStatus = "completed" | "failed" | "cancelled" | "timeout" | "input_required";

export interface TurnOutcome {
  status: TurnOutcomeStatus;
  error?: string;
}

export interface StartTurnOptions {
  /** `<issue.identifier>: <issue.title>` or similar, forwarded when the protocol supports titles. */
  title: string;
}

/** A live coding-agent thread bound to one worker run (SPEC.md 4.1.6, 10.2). */
export interface AgentSession {
  readonly sessionId: string | null;
  readonly threadId: string | null;

  /** Start one turn on the live thread and resolve once it reaches a terminal state. */
  startTurn(prompt: string, options: StartTurnOptions): Promise<TurnOutcome>;

  /** Stop the underlying subprocess/session. Safe to call multiple times. */
  stop(): Promise<void>;
}

export interface StartSessionOptions {
  workspacePath: string;
  issue: Issue;
  codexConfig: CodexConfig;
  onEvent: (event: AgentRuntimeEvent) => void;
}

/**
 * Agent Runner Protocol boundary (SPEC.md Section 10), deliberately decoupled from any one
 * coding-agent CLI's wire protocol. Symphony's core orchestration logic (Section 16) only depends
 * on this interface: create/reuse workspace happens in the caller (`WorkspaceManager`), and this
 * interface covers "start app-server session" + "forward events" + "fail on error" (SPEC.md
 * 10.7). Swap in a different coding agent by implementing {@link AgentRunner} against its native
 * protocol; `SubprocessAgentRunner` (./subprocessRunner.ts) is the shipped reference
 * implementation and documents its own wire format in docs/agent-runner-protocol.md rather than
 * assuming the OpenAI Codex app-server protocol.
 */
export interface AgentRunner {
  startSession(options: StartSessionOptions): Promise<Result<AgentSession, AgentError>>;
}
