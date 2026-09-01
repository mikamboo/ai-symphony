import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import crypto from "node:crypto";
import { err, ok, AgentError, type Result } from "../domain/errors.js";
import type {
  AgentRunner,
  AgentRuntimeEvent,
  AgentSession,
  StartSessionOptions,
  StartTurnOptions,
  TurnOutcome
} from "./runner.js";
import { issueToTemplateContext } from "../prompt/render.js";

const MAX_LINE_BYTES = 10 * 1024 * 1024; // SPEC.md 10.1 recommended max line size

/**
 * Reference wire protocol for {@link SubprocessAgentRunner}. This is Symphony's own
 * newline-delimited JSON protocol, NOT the OpenAI Codex app-server protocol -- see
 * docs/agent-runner-protocol.md for the full contract. Launch a different coding agent by
 * implementing {@link AgentRunner} directly against its native transport instead of adapting it
 * to this shape.
 *
 * Client -> subprocess (stdin, one JSON object per line):
 *   {"type":"session.start","cwd":string,"issue":object,"config":object}
 *   {"type":"turn.start","turn_id":string,"prompt":string,"title":string}
 *   {"type":"session.stop"}
 *
 * Subprocess -> client (stdout, one JSON object per line):
 *   {"type":"session.started","thread_id":string}
 *   {"type":"session.start_failed","error":string}
 *   {"type":"turn.update", ...}                      (zero or more per turn)
 *   {"type":"turn.completed","turn_id":string}
 *   {"type":"turn.failed","turn_id":string,"error":string}
 *   {"type":"turn.cancelled","turn_id":string}
 *   {"type":"turn.input_required","turn_id":string}
 *
 * stderr is diagnostic-only and never parsed as protocol (SPEC.md 10.3 transport requirement).
 */

interface OutboundLine {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

class SubprocessAgentSession implements AgentSession {
  sessionId: string | null = null;
  threadId: string | null = null;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, OutboundLine>();
  private readTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly readTimeoutMs: number,
    private readonly turnTimeoutMs: number,
    private readonly onEvent: (event: AgentRuntimeEvent) => void
  ) {
    this.child = child;
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      this.onEvent({ event: "malformed", timestamp: new Date().toISOString(), payload: { reason: "line_too_large" } });
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.onEvent({ event: "malformed", timestamp: new Date().toISOString(), payload: { raw: line } });
      return;
    }

    const type = typeof msg.type === "string" ? msg.type : "other_message";
    this.onEvent({ event: type, timestamp: new Date().toISOString(), payload: msg, codexAppServerPid: String(this.child.pid ?? "") });

    if (type === "session.started") {
      this.threadId = typeof msg.thread_id === "string" ? msg.thread_id : null;
      this.pending.get("session.start")?.resolve(msg);
      return;
    }
    if (type === "session.start_failed") {
      this.pending.get("session.start")?.reject(new AgentError("response_error", String(msg.error ?? "session start failed")));
      return;
    }

    const turnId = typeof msg.turn_id === "string" ? msg.turn_id : undefined;
    if (turnId && this.pending.has(turnId)) {
      if (type === "turn.completed") this.pending.get(turnId)?.resolve({ status: "completed" });
      else if (type === "turn.failed") this.pending.get(turnId)?.resolve({ status: "failed", error: String(msg.error ?? "turn failed") });
      else if (type === "turn.cancelled") this.pending.get(turnId)?.resolve({ status: "cancelled" });
      else if (type === "turn.input_required") this.pending.get(turnId)?.resolve({ status: "input_required" });
      else this.resetReadTimer(turnId);
    }
  }

  private resetReadTimer(turnId: string): void {
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      const pending = this.pending.get(turnId);
      pending?.resolve({ status: "timeout", error: "turn stream silence timeout" });
    }, this.turnTimeoutMs);
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async startHandshake(cwd: string, issue: unknown, config: unknown): Promise<void> {
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete("session.start");
        reject(new AgentError("response_timeout", `No session.started response within ${this.readTimeoutMs}ms`));
      }, this.readTimeoutMs);

      this.pending.set("session.start", {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e as Error);
        }
      });
    });

    this.send({ type: "session.start", cwd, issue, config });
    await promise;
  }

  async startTurn(prompt: string, options: StartTurnOptions): Promise<TurnOutcome> {
    const turnId = crypto.randomUUID();

    const outcome = await new Promise<TurnOutcome>((resolve) => {
      this.pending.set(turnId, {
        resolve: (v) => resolve(v as TurnOutcome),
        reject: () => resolve({ status: "failed", error: "turn errored" })
      });
      this.resetReadTimer(turnId);
      this.send({ type: "turn.start", turn_id: turnId, prompt, title: options.title });
    });

    this.pending.delete(turnId);
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
    }
    return outcome;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.readTimer) clearTimeout(this.readTimer);
    try {
      this.send({ type: "session.stop" });
    } catch {
      // subprocess may already be gone
    }
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 3000);
      this.child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }
}

export interface SubprocessAgentRunnerOptions {
  /**
   * Environment variable names to strip from the coding-agent child process (SPEC.md 15.3):
   * tracker credentials MUST NOT be inherited by the child. Typically
   * `trackerAdapter.secretEnvironmentNames()`.
   */
  secretEnvNames?: string[];
}

export class SubprocessAgentRunner implements AgentRunner {
  private readonly secretEnvNames: Set<string>;

  constructor(options: SubprocessAgentRunnerOptions = {}) {
    this.secretEnvNames = new Set(options.secretEnvNames ?? []);
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of this.secretEnvNames) delete env[name];
    return env;
  }

  async startSession(options: StartSessionOptions): Promise<Result<AgentSession, AgentError>> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("bash", ["-lc", options.codexConfig.command], {
        cwd: options.workspacePath,
        stdio: ["pipe", "pipe", "pipe"],
        env: this.childEnv()
      });
    } catch (cause) {
      return err(new AgentError("codex_not_found", `Failed to launch agent command: ${String(cause)}`, { cause }));
    }

    child.stderr.on("data", () => {
      // Diagnostic-only per SPEC.md 10.3; intentionally not parsed as protocol.
    });

    const session = new SubprocessAgentSession(child, options.codexConfig.readTimeoutMs, options.codexConfig.turnTimeoutMs, options.onEvent);

    const spawnFailure = await new Promise<AgentError | null>((resolve) => {
      const onError = (cause: Error) => resolve(new AgentError("codex_not_found", `Agent process error: ${cause.message}`, { cause }));
      const onEarlyExit = (code: number | null) => resolve(new AgentError("port_exit", `Agent process exited early with code ${code}`));
      child.once("error", onError);
      child.once("exit", onEarlyExit);
      setTimeout(() => resolve(null), 0);
    });
    if (spawnFailure) return err(spawnFailure);

    try {
      await session.startHandshake(
        options.workspacePath,
        issueToTemplateContext(options.issue),
        {
          approval_policy: options.codexConfig.approvalPolicy,
          thread_sandbox: options.codexConfig.threadSandbox,
          turn_sandbox_policy: options.codexConfig.turnSandboxPolicy
        }
      );
    } catch (cause) {
      await session.stop();
      if (cause instanceof AgentError) return err(cause);
      return err(new AgentError("response_error", `Session startup failed: ${String(cause)}`, { cause }));
    }

    return ok(session);
  }
}
