import { ok, type Result, type AgentError } from "../domain/errors.js";
import type { AgentRunner, AgentSession, StartSessionOptions, StartTurnOptions, TurnOutcome } from "./runner.js";

export type ScriptedTurn = TurnOutcome | ((turnNumber: number) => TurnOutcome);

/**
 * Deterministic {@link AgentRunner} test double: no subprocess, no protocol -- just replays a
 * scripted sequence of turn outcomes so orchestrator logic (Section 16) can be unit tested without
 * a real coding-agent binary.
 */
export class MockAgentRunner implements AgentRunner {
  public startedSessions: { workspacePath: string; issueId: string }[] = [];
  public prompts: string[] = [];

  constructor(private readonly script: ScriptedTurn[] = [{ status: "completed" }]) {}

  async startSession(options: StartSessionOptions): Promise<Result<AgentSession, AgentError>> {
    this.startedSessions.push({ workspacePath: options.workspacePath, issueId: options.issue.id });
    let turnNumber = 0;

    const session: AgentSession = {
      sessionId: `mock-thread-${options.issue.id}-turn0`,
      threadId: `mock-thread-${options.issue.id}`,
      startTurn: async (prompt: string, _options: StartTurnOptions): Promise<TurnOutcome> => {
        this.prompts.push(prompt);
        const scripted = this.script[Math.min(turnNumber, this.script.length - 1)];
        turnNumber += 1;
        options.onEvent({ event: "turn_completed", timestamp: new Date().toISOString() });
        return typeof scripted === "function" ? scripted(turnNumber) : scripted ?? { status: "completed" };
      },
      stop: async () => {
        // No subprocess to tear down.
      }
    };

    return ok(session);
  }
}
