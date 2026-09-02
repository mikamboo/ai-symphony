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

## Status: which agents actually work today

Easy to misread from the `codex.command` field name, so stated plainly:

| Agent runner              | Status                        | Notes                                                                 |
| -------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `SubprocessAgentRunner`    | Works, but not a real agent    | Speaks Symphony's own made-up protocol (below). Exists so the orchestrator itself is runnable/testable end-to-end. Pointing `codex.command` at the real `codex` binary does **not** work — see next row. |
| Real Codex app-server      | **Not implemented**            | `codex.command` defaults to `"codex app-server"`, but no client for Codex's actual JSON-RPC-style app-server protocol exists in this repo. This was an explicit scope decision (SPEC.md Section 10 is written specifically against that protocol; this implementation chose the `AgentRunner` abstraction over implementing it) — not an oversight, but also not "done, just needs alternatives." Building it is comparable-or-larger effort than `ClaudeCodeAgentRunner` below: it's a stateful session/turn protocol, and SPEC.md itself warns against guessing at it (`codex app-server generate-json-schema` is the documented source of truth) rather than writing it from memory. |
| `ClaudeCodeAgentRunner`    | **Implemented** (`src/agent/claudeCodeRunner.ts`) | Drives the real `claude` CLI. See its own section below. |
| DeepSeek (or similar bare model API) | Not applicable directly | DeepSeek is a model, not a coding agent — no CLI, no workspace access, no tool-calling loop of its own. There's nothing to implement `AgentRunner` against. Either point an *existing* agent CLI that supports custom OpenAI-compatible endpoints at it, then write `AgentRunner` against *that* CLI, or build your own harness (prompt loop + tool-calling + file edits) against its chat-completions API — the latter is building an agent, not writing an adapter. |

Select `SubprocessAgentRunner` vs. `ClaudeCodeAgentRunner` at the CLI layer via the
`agent_runner.kind` `WORKFLOW.md` extension field (`src/agent/registry.ts`) — see
`examples/claude-code/WORKFLOW.md`. This field is a Symphony-CLI convenience on top of SPEC.md,
not part of its core schema: the spec treats the coding agent as a deploy-time integration choice
(implement `AgentRunner`), not a declarative config value.

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

## `ClaudeCodeAgentRunner`: driving the real Claude Code CLI

`src/agent/claudeCodeRunner.ts` implements `AgentRunner` against the actual `claude` CLI (`-p`,
`--output-format stream-json`), not a made-up protocol. The full behavior — invocation model,
permission mode and why `bypassPermissions` doesn't work as root, the exact `result`/`usage` event
shape, what's deliberately not implemented (`thread_sandbox`, `turn_sandbox_policy`) — is
documented in that file's class-level doc comment rather than duplicated here; read it before
changing this runner. Everything stated there as "confirmed" was checked by directly invoking
`claude` 2.1.258 in this repo's dev environment, not sourced from Anthropic's public docs.

Test coverage: `src/agent/claudeCodeRunner.test.ts` (deterministic, runs against a fake `claude`
stub, always runs) and `src/agent/claudeCodeRunner.live.test.ts` (real `claude` CLI, opt-in via
`SYMPHONY_TEST_LIVE_CLAUDE_CODE=1`, costs real API usage — see linear.schema.test.ts for the same
opt-in pattern applied to a different adapter).

One architectural limitation carried over from `SubprocessAgentRunner`, not specific to this
runner: `Orchestrator` snapshots `AgentSession.sessionId`/`.threadId` once, immediately after
`startSession()` resolves (see `runAgentAttempt` in `src/orchestrator/orchestrator.ts`) — before
any turn has run. Both runners only learn the real session/thread ID once the first turn's output
arrives, so that snapshot is `null` even after a turn completes; the real ID is still visible via
the `session_started` event both runners emit through `onEvent`, just not through the typed
`RunningEntry.session.sessionId` field the orchestrator's snapshot API exposes. Not fixed here: it
would mean changing `Orchestrator`'s read timing generically for both runners (a legitimate,
scoped follow-up, not "special-casing" either one), but is out of scope for adding this runner and
is a cosmetic observability gap rather than a correctness one.
