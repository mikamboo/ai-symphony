import type { CodexTotals, OrchestratorState } from "../domain/types.js";

export interface RunningRow {
  issueId: string;
  identifier: string;
  url: string | null;
  state: string;
  sessionId: string | null;
  turnCount: number;
  startedAt: number;
}

export interface RetryingRow {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error: string | null;
}

/** Runtime snapshot shape (SPEC.md 13.3). */
export interface RuntimeSnapshot {
  running: RunningRow[];
  retrying: RetryingRow[];
  codexTotals: CodexTotals & { secondsRunning: number };
  rateLimits: unknown;
}

export function buildSnapshot(state: OrchestratorState): RuntimeSnapshot {
  const now = Date.now();
  let liveSeconds = 0;
  const running: RunningRow[] = [];
  for (const [issueId, entry] of state.running) {
    liveSeconds += (now - entry.startedAt) / 1000;
    running.push({
      issueId,
      identifier: entry.identifier,
      url: entry.issue.url,
      state: entry.issue.state,
      sessionId: entry.session.sessionId,
      turnCount: entry.session.turnCount,
      startedAt: entry.startedAt
    });
  }

  const retrying: RetryingRow[] = [];
  for (const [issueId, entry] of state.retryAttempts) {
    retrying.push({ issueId, identifier: entry.identifier, attempt: entry.attempt, dueAtMs: entry.dueAtMs, error: entry.error });
  }

  return {
    running,
    retrying,
    codexTotals: { ...state.codexTotals, secondsRunning: state.codexTotals.secondsRunning + liveSeconds },
    rateLimits: state.codexRateLimits
  };
}
