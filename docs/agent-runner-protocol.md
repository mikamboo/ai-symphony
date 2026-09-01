# Agent Runner Protocol

SPEC.md Section 10 is written specifically against the OpenAI Codex app-server protocol. This
implementation deliberately decouples Symphony's core orchestration logic (Section 16) from any
one coding agent's wire protocol via the `AgentRunner` interface (`src/agent/runner.ts`):

```ts
interface AgentRunner {
  startSession(options: StartSessionOptions): Promise<Result<AgentSession, AgentError>>;
}

interface AgentSession {
  readonly sessionId: string | null;
  readonly threadId: string | null;
  startTurn(prompt: string, options: StartTurnOptions): Promise<TurnOutcome>;
  stop(): Promise<void>;
}
```

The orchestrator only depends on this interface. Workspace creation/reuse and hook execution
happen in `WorkspaceManager` before `startSession` is called; prompt rendering happens in
`src/prompt/render.ts` before each `startTurn` call. This satisfies the Agent Runner Contract in
SPEC.md 10.7 (create/reuse workspace, build prompt, start session, forward events, fail the
attempt on any error) without hard-coding a specific coding agent's transport.

To integrate a different coding agent (the real Codex app-server, Claude Code, or anything else),
implement `AgentRunner` directly against that agent's native protocol. You do not need to adapt it
to the protocol described below.

## Reference implementation: `SubprocessAgentRunner`

`src/agent/subprocessRunner.ts` ships a default, working implementation. It launches
`bash -lc <codex.command>` in the workspace directory and speaks **Symphony's own** newline-delimited
JSON protocol over stdio — this is *not* the OpenAI Codex app-server protocol. It exists so the
service is runnable end-to-end (including the CLI lifecycle and reconciliation/stall-timeout
behavior) without depending on a specific external binary or its exact wire format, per the
project's decision to abstract the agent-runner boundary (see the JSDoc in `runner.ts`).

### Transport

- stdin/stdout: newline-delimited JSON, one object per line, UTF-8. Max line size 10 MB (SPEC.md
  10.1); an oversized line is reported as a `malformed` event and ignored.
- stderr: diagnostic-only, never parsed as protocol (SPEC.md 10.3).

### Client → subprocess (stdin)

```jsonc
{"type": "session.start", "cwd": "<workspace path>", "issue": { /* normalized issue, snake_case */ }, "config": {"approval_policy": ..., "thread_sandbox": ..., "turn_sandbox_policy": ...}}
{"type": "turn.start", "turn_id": "<uuid>", "prompt": "<rendered prompt or continuation guidance>", "title": "<issue.identifier>: <issue.title>"}
{"type": "session.stop"}
```

### Subprocess → client (stdout)

```jsonc
{"type": "session.started", "thread_id": "<string>"}
{"type": "session.start_failed", "error": "<string>"}
{"type": "turn.update", "turn_id": "<uuid>", ...}          // zero or more per turn; observability only
{"type": "turn.completed", "turn_id": "<uuid>"}
{"type": "turn.failed", "turn_id": "<uuid>", "error": "<string>"}
{"type": "turn.cancelled", "turn_id": "<uuid>"}
{"type": "turn.input_required", "turn_id": "<uuid>"}
```

Every line the client receives is also forwarded upstream to the orchestrator as an
`AgentRuntimeEvent` (SPEC.md 10.4) with `event` set to the line's `type` field, so custom
`turn.update` payloads are visible for observability even though the orchestrator's control flow
only reacts to the terminal turn events listed above.

### Timeouts

- `codex.read_timeout_ms`: how long the client waits for `session.started` /
  `session.start_failed` after sending `session.start`.
- `codex.turn_timeout_ms`: reset on every line received for the active turn; if no line arrives
  within this window the client synthesizes a `{status: "timeout"}` outcome for that turn (turn
  stream silence timeout, SPEC.md 10.6).
- `codex.stall_timeout_ms`: enforced by the **orchestrator**, not this client — see
  `Orchestrator.reconcileStalledRuns` in `src/orchestrator/orchestrator.ts`.

### User-input / approval policy (SPEC.md 10.5, 15.1)

This reference implementation's documented posture: it does not implement interactive approval or
user-input flows. A `turn.input_required` response is surfaced to the orchestrator as a
non-`completed` `TurnOutcome`, which the worker loop treats as an abnormal exit (scheduled for
retry with exponential backoff), matching the "fail the run" option SPEC.md 10.5 allows. There is
no operator-approval channel in this pass. Deployers should treat this as a high-trust-environment
default and hardened per SPEC.md 15.5 as needed (tighter sandboxing, network restrictions,
narrower tracker scope) before running it against untrusted issue content.

### Secrets

Tracker credentials are never passed to the agent subprocess: `SubprocessAgentRunner` accepts a
`secretEnvNames` list (populated from `TrackerAdapter.secretEnvironmentNames()`) and strips those
names from the child's environment before spawning (SPEC.md 15.3).
