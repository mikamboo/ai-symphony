import { spawn, execFile, type ChildProcessByStdio } from "node:child_process";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
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

const execFileAsync = promisify(execFile);

const MAX_LINE_BYTES = 10 * 1024 * 1024; // SPEC.md 10.1 recommended max line size

/**
 * AgentRunner implementation against the real Claude Code CLI (`claude`), verified interactively
 * against `claude` 2.1.258 rather than written from memory (see the class of bug this avoided:
 * docs/adapters/linear.md's "Real integration profile" section).
 *
 * ## Invocation model
 *
 * Unlike `SubprocessAgentRunner` (one long-lived app-server subprocess per worker run, driven by
 * a session/turn protocol over stdio), Claude Code's `-p`/`--print` mode is one process per turn.
 * `startSession()` therefore does not spawn anything — it only preflight-checks the binary — and
 * each `startTurn()` call spawns a fresh `claude -p <prompt>` process:
 *
 * - First turn: `claude -p <prompt> --output-format stream-json --verbose
 *   --permission-mode <mode> --session-id <generated-uuid>`
 * - Later turns (continuation, same worker run): the same, with `--resume <that-uuid>` instead of
 *   `--session-id`, so conversation history carries over exactly like a persistent thread would.
 *
 * `--session-id` is passed explicitly (never left to the CLI to generate) because in a nested
 * Claude Code environment the child can otherwise inherit the parent session's ID from ambient
 * state; forcing it removes that ambiguity regardless of environment.
 *
 * `--output-format stream-json` REQUIRES `--verbose` in `--print` mode or the CLI refuses to
 * start (`Error: When using --print, --output-format=stream-json requires --verbose`) —
 * confirmed by running it, not documented prominently in `--help`.
 *
 * ## Permission mode
 *
 * Defaults to `acceptEdits`. `bypassPermissions` / `--dangerously-skip-permissions` are refused
 * outright by the CLI when running as root/sudo ("cannot be used with root/sudo privileges for
 * security reasons") — confirmed interactively — which a containerized Symphony daemon very
 * plausibly is. `acceptEdits` was confirmed to run file-writing tool calls with zero prompts and
 * `permission_denials: []` under root. This is Symphony's high-trust-environment posture (see
 * docs/agent-runner-protocol.md and README "Security / trust posture") applied to this runner;
 * there is no operator-approval channel here either.
 *
 * ## Turn outcome and usage
 *
 * The terminal event on stdout is a `{"type":"result", "is_error": boolean, "result": string,
 * "usage": {"input_tokens": number, "output_tokens": number, ...}, "session_id": string, ...}`
 * object (confirmed by direct invocation, not Anthropic's public docs, which describe the shape
 * similarly but weren't cross-checked here). `is_error` is the single signal this runner trusts
 * to distinguish success from failure; only the `subtype: "success"` / `is_error: false` case has
 * been directly observed, not e.g. a max-turns-exceeded or execution-error run. Token usage is
 * per-invocation (each turn is a separate process), so it is forwarded as a delta
 * (`usage.absolute: false`), not an absolute thread total.
 *
 * ## `codex.command`
 *
 * Reinterpreted for this runner: it is the bare `claude` binary name/path (default `"claude"`),
 * NOT a full shell command line the way `SubprocessAgentRunner` treats it — this runner builds
 * its own argv and spawns without a shell, so prompt text and flags never pass through shell
 * interpolation. If you switch `WORKFLOW.md`'s `agent_runner.kind` to `claude_code`, also set
 * `codex.command: "claude"` (or an absolute path) — the SPEC.md-documented default
 * `"codex app-server"` is not a valid binary name and `startSession` rejects it early.
 *
 * ## Not implemented
 *
 * `codex.approval_policy` beyond the permission-mode mapping below; `codex.thread_sandbox` /
 * `codex.turn_sandbox_policy` (Codex-specific sandbox concepts with no verified Claude Code CLI
 * equivalent — silently ignored rather than guessed at); `codex.read_timeout_ms` (no separate
 * handshake phase exists to time; `turn_timeout_ms`'s per-line silence timer already covers "no
 * output at all" from the moment a turn starts).
 */

const VALID_PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
const DEFAULT_PERMISSION_MODE = "acceptEdits";

export interface ClaudeCodeAgentRunnerOptions {
  /** Environment variable names to strip from the `claude` child process (SPEC.md 15.3). */
  secretEnvNames?: string[];
  /**
   * `claude --permission-mode` value. Defaults to `"acceptEdits"`. `"bypassPermissions"` is
   * refused by the CLI when the host process runs as root/sudo — see the class-level doc comment.
   */
  permissionMode?: string;
}

class ClaudeCodeSession implements AgentSession {
  sessionId: string | null = null;
  threadId: string | null = null;
  private currentChild: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private stopped = false;

  constructor(
    private readonly claudeBinary: string,
    private readonly workspacePath: string,
    private readonly permissionMode: string,
    private readonly turnTimeoutMs: number,
    private readonly childEnv: NodeJS.ProcessEnv,
    private readonly onEvent: (event: AgentRuntimeEvent) => void
  ) {}

  async startTurn(prompt: string, options: StartTurnOptions): Promise<TurnOutcome> {
    if (this.stopped) return { status: "cancelled" };

    const isFirstTurn = this.threadId === null;
    const turnSessionId = this.threadId ?? crypto.randomUUID();

    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.permissionMode,
      isFirstTurn ? "--session-id" : "--resume",
      turnSessionId
    ];
    if (isFirstTurn) args.push("--name", options.title);

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(this.claudeBinary, args, { cwd: this.workspacePath, stdio: ["ignore", "pipe", "pipe"], env: this.childEnv });
    } catch (cause) {
      return { status: "failed", error: `Failed to launch claude: ${String(cause)}` };
    }
    this.currentChild = child;

    child.stderr.on("data", () => {
      // Diagnostic-only per SPEC.md 10.3; intentionally not parsed as protocol.
    });

    const outcome = await new Promise<TurnOutcome>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const settle = (result: TurnOutcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => settle({ status: "timeout", error: "turn stream silence timeout" }), this.turnTimeoutMs);
      };
      resetTimer();

      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        resetTimer();
        this.handleLine(line, settle);
      });

      child.once("error", (cause) => {
        settle({ status: "failed", error: `claude process error: ${cause.message}` });
      });
      child.once("exit", (code) => {
        settle({ status: "failed", error: `claude exited with code ${code} before emitting a result` });
      });
    });

    this.currentChild = null;
    return outcome;
  }

  private handleLine(line: string, settle: (result: TurnOutcome) => void): void {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      this.onEvent({ event: "malformed", timestamp: new Date().toISOString(), payload: { reason: "line_too_large" } });
      return;
    }

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.onEvent({ event: "malformed", timestamp: new Date().toISOString(), payload: { raw: line } });
      return;
    }

    const type = typeof obj.type === "string" ? obj.type : "other_message";
    const timestamp = new Date().toISOString();
    this.onEvent({ event: type, timestamp, payload: obj });

    if (this.threadId === null && typeof obj.session_id === "string") {
      this.threadId = obj.session_id;
      this.sessionId = obj.session_id;
      this.onEvent({ event: "session_started", timestamp, payload: { session_id: obj.session_id } });
    }

    if (type !== "result") return;

    const usage = obj.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (usage) {
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      this.onEvent({
        event: "usage",
        timestamp,
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, absolute: false }
      });
    }

    if (obj.is_error === true) {
      settle({ status: "failed", error: typeof obj.result === "string" ? obj.result : "claude turn failed" });
    } else {
      settle({ status: "completed" });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.currentChild;
    if (!child) return;

    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

export class ClaudeCodeAgentRunner implements AgentRunner {
  private readonly secretEnvNames: Set<string>;
  private readonly permissionMode: string;

  constructor(options: ClaudeCodeAgentRunnerOptions = {}) {
    this.secretEnvNames = new Set(options.secretEnvNames ?? []);
    this.permissionMode =
      options.permissionMode && VALID_PERMISSION_MODES.has(options.permissionMode) ? options.permissionMode : DEFAULT_PERMISSION_MODE;
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of this.secretEnvNames) delete env[name];
    return env;
  }

  async startSession(options: StartSessionOptions): Promise<Result<AgentSession, AgentError>> {
    const claudeBinary = options.codexConfig.command.trim() || "claude";
    if (/\s/.test(claudeBinary)) {
      return err(
        new AgentError(
          "codex_not_found",
          `codex.command for ClaudeCodeAgentRunner must be a bare binary name/path (e.g. "claude"), got "${claudeBinary}". ` +
            "Flags are built by this runner, not parsed out of codex.command."
        )
      );
    }

    try {
      await execFileAsync(claudeBinary, ["--version"], { timeout: 5000 });
    } catch (cause) {
      return err(new AgentError("codex_not_found", `Could not run "${claudeBinary} --version": ${String(cause)}`, { cause }));
    }

    return ok(
      new ClaudeCodeSession(
        claudeBinary,
        options.workspacePath,
        this.permissionMode,
        options.codexConfig.turnTimeoutMs,
        this.childEnv(),
        options.onEvent
      )
    );
  }
}
