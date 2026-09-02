# AI Symphony

A TypeScript/Node.js implementation of **Symphony**, the coding-agent orchestration service
specified in [`SPEC.md`](./SPEC.md): a long-running daemon that polls a configured issue tracker,
creates an isolated per-issue workspace, and runs a coding-agent session for each eligible issue.

This implementation targets **Core Conformance** (SPEC.md Section 18.1): the required workflow
loader, config layer, orchestrator state machine, workspace manager, tracker adapter contract, and
structured logging. The OPTIONAL HTTP status server, provider-native agent tools, and the
Appendix A SSH worker extension are out of scope for this pass.

![Symphony architecture: WORKFLOW.md feeds a Workflow Loader and Config Layer into a central Orchestrator, which polls a pluggable Tracker Adapter, drives a pluggable Agent Runner that spawns a coding-agent subprocess inside a sandboxed per-issue workspace managed by the Workspace Manager, and emits structured logs.](./docs/architecture.svg)

## Status at a glance

| Area                                             | Status                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| Workflow loader + dynamic `WORKFLOW.md` reload    | Implemented (`src/workflow/`)                                    |
| Typed config layer, `$VAR`/`~` resolution         | Implemented (`src/config/`)                                      |
| Workspace manager, hooks, safety invariants       | Implemented (`src/workspace/`)                                   |
| Orchestrator (poll/dispatch/reconcile/retry)      | Implemented (`src/orchestrator/`)                                 |
| Tracker adapter contract                          | Implemented (`src/tracker/adapter.ts`)                            |
| Linear tracker adapter                            | Implemented, read-only (`src/tracker/linear.ts`, profile in [`docs/adapters/linear.md`](./docs/adapters/linear.md)) |
| Mock tracker adapter (tests / local smoke runs)   | Implemented (`src/tracker/mock.ts`)                               |
| Agent Runner interface                            | Implemented, decoupled from any one coding agent's wire protocol (`src/agent/runner.ts`) |
| Reference `SubprocessAgentRunner`                 | Implemented against Symphony's own protocol, not the Codex app-server protocol — see [`docs/agent-runner-protocol.md`](./docs/agent-runner-protocol.md) |
| `ClaudeCodeAgentRunner`                           | Implemented, drives the real `claude` CLI (`src/agent/claudeCodeRunner.ts`) — select via `agent_runner.kind: claude_code` |
| Real OpenAI Codex app-server client                | **Not implemented** despite `codex.command`'s naming — see [`docs/agent-runner-protocol.md`](./docs/agent-runner-protocol.md) "Status" section |
| Structured logging                                | Implemented (`src/logging/logger.ts`)                             |
| CLI                                                | Implemented (`src/cli.ts`)                                        |
| HTTP status server, provider-native tracker tools, session persistence across restarts | Not implemented (SPEC.md 18.2 RECOMMENDED extensions) |

## Quick start

```bash
pnpm install
pnpm run build

# Smoke-test the daemon lifecycle with the in-memory mock tracker (no real issues dispatch,
# but this exercises startup, polling, dynamic reload, and shutdown end-to-end):
pnpm run dev -- examples/mock/WORKFLOW.md

# Against a real Linear workspace:
export LINEAR_API_KEY=lin_api_...
pnpm run dev -- examples/linear/WORKFLOW.md

# Select the real Claude Code CLI as the coding agent instead of the reference protocol
# (requires `claude` on PATH; still uses the mock tracker, so nothing dispatches by default):
pnpm run dev -- examples/claude-code/WORKFLOW.md
```

This project uses [pnpm](https://pnpm.io) (pinned via the `packageManager` field in
`package.json`; run `corepack enable` if your `pnpm` doesn't match). `pnpm run dev` runs the CLI
directly against TypeScript source via `tsx`; `pnpm start` runs the built `dist/cli.js`. The CLI
accepts a positional `path-to-WORKFLOW.md` argument (or `--workflow <path>` / `-w <path>`) and
defaults to `./WORKFLOW.md` in the current working directory (SPEC.md 17.7).

See [`examples/README.md`](./examples/README.md) for what each example actually demonstrates,
prerequisites, and expected output.

Stop the service with `Ctrl-C` (`SIGINT`) or `SIGTERM`; it drains in-flight workers and exits 0.

## Architecture

```
src/
  domain/        Core types (Issue, ServiceConfig, OrchestratorState, ...) and typed errors — SPEC.md §4
  workflow/       WORKFLOW.md loader (YAML front matter + prompt body) and file watcher — SPEC.md §5, §6.2
  config/         Typed config resolution, $VAR/~ expansion, dispatch preflight validation — SPEC.md §6
  workspace/      Per-issue workspace manager, lifecycle hooks, path-safety invariants — SPEC.md §9, §15.2
  tracker/        TrackerAdapter contract + Linear adapter + in-memory mock adapter — SPEC.md §11
  prompt/         Strict Liquid-based prompt rendering + continuation guidance — SPEC.md §12
  agent/          AgentRunner contract + subprocess reference implementation + mock — SPEC.md §10
  orchestrator/   Poll loop, dispatch, reconciliation, retry/backoff (the state machine) — SPEC.md §7, §8, §16
  logging/        Structured key=value logger with secret redaction — SPEC.md §13.1-13.2
  cli.ts          Startup wiring / process lifecycle — SPEC.md §16.1, §17.7
```

Everything above the `orchestrator/` layer is written against interfaces
(`TrackerAdapter`, `AgentRunner`) rather than concrete providers, matching SPEC.md's layered
abstraction guidance (Section 3.2): swap in a different tracker or coding agent by implementing
the relevant interface, without touching orchestration logic.

## Configuring a workflow

Runtime behavior is entirely driven by a repository-owned `WORKFLOW.md` (SPEC.md Section 5): YAML
front matter for typed config, then a Markdown prompt template rendered per issue with strict
variable/filter checking (unknown template variables/filters fail the render). See
[`examples/linear/WORKFLOW.md`](./examples/linear/WORKFLOW.md) for a fully annotated example and
[`SPEC.md` Section 5.3](./SPEC.md) / [Section 6.4](./SPEC.md) for the full field reference.
`WORKFLOW.md` is watched for changes and re-applied live without a restart (SPEC.md 6.2); invalid
reloads are logged and the service keeps running on the last-known-good config.

## Writing a tracker adapter

Implement `TrackerAdapter` (`src/tracker/adapter.ts`):

```ts
interface TrackerAdapter {
  readonly kind: string;
  fetchIssuesByStates(stateNames: string[]): Promise<Result<Issue[], TrackerError>>;
  fetchIssuesByIds(issueIds: string[]): Promise<Result<Issue[], TrackerError>>;
  secretEnvironmentNames(): string[];
}
```

then register a factory with `registerTrackerAdapter("your_kind", factory)`
(`src/tracker/registry.ts`) before the CLI resolves `tracker.kind` from `WORKFLOW.md`. See
[`src/tracker/linear.ts`](./src/tracker/linear.ts) and its profile doc
([`docs/adapters/linear.md`](./docs/adapters/linear.md)) for a worked example, including
normalization, pagination, and error-category mapping (SPEC.md Section 11).

## Writing an agent runner

Implement `AgentRunner` (`src/agent/runner.ts`) against your coding agent's native protocol. See
[`docs/agent-runner-protocol.md`](./docs/agent-runner-protocol.md) for why this is a deliberately
decoupled interface rather than a hard-coded Codex app-server client, which agents actually work
today (short version: `SubprocessAgentRunner`'s own made-up protocol, and now Claude Code — *not*
the real Codex app-server, despite `codex.command`'s naming), and the reference protocol
`SubprocessAgentRunner` speaks by default. Register a new runner's selection in
`src/agent/registry.ts` alongside `ClaudeCodeAgentRunner` if you want it chosen via
`agent_runner.kind` in `WORKFLOW.md` the same way.

## Security / trust posture (SPEC.md Section 15)

- **Trust boundary**: this implementation targets a **trusted, high-approval environment**. Every
  shipped `AgentRunner` reflects that: `SubprocessAgentRunner` has no operator-approval channel at
  all (`turn.input_required` is treated as a failed turn, retried with backoff); `ClaudeCodeAgentRunner`
  runs `claude` with `--permission-mode acceptEdits` by default (`bypassPermissions` is refused by
  the CLI itself when running as root — confirmed interactively, see
  `src/agent/claudeCodeRunner.ts`), which auto-approves file edits and tool calls with no human in
  the loop. Do not point either at untrusted issue trackers or repositories without adding your
  own approval/sandboxing layer first (SPEC.md 15.5).
- **Filesystem safety**: workspace paths are sanitized (SPEC.md 9.2/15.2 invariant 3) and asserted
  to stay inside the configured `workspace.root` (invariant 2) before every hook run and agent
  launch (invariant 1). See `assertWithinRoot` in `src/workspace/manager.ts`.
- **Secrets**: `$VAR_NAME` indirection is supported for tracker credentials; the logger redacts
  any field whose key looks secret-shaped; tracker adapters declare `secretEnvironmentNames()`,
  which the CLI strips from the coding-agent child process environment before spawning it (SPEC.md
  15.3).
- **Hooks**: `WORKFLOW.md` hooks are trusted, arbitrary shell scripts run with a configurable
  timeout (`hooks.timeout_ms`); they are not sandboxed beyond normal OS process boundaries.

## Development

```bash
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest run — unit + integration tests, see Section 17 mapping below
pnpm run build       # emit dist/
```

### Test coverage vs. SPEC.md Section 17 (Core Conformance)

| Spec section                                  | Test file(s)                                             |
| ----------------------------------------------- | ---------------------------------------------------------- |
| 17.1 Workflow and Config Parsing                | `src/workflow/loader.test.ts`, `src/config/resolve.test.ts`, `src/prompt/render.test.ts` |
| 17.2 Workspace Manager and Safety               | `src/workspace/manager.test.ts`                            |
| 17.3 Issue Tracker Adapter                      | `src/tracker/mock.test.ts` (contract-level; see `docs/adapters/linear.md` for the Linear-specific profile) |
| 17.4 Orchestrator Dispatch, Reconciliation, Retry | `src/orchestrator/selection.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| 17.5 Coding-Agent App-Server Client              | Not applicable to the real Codex app-server protocol, which isn't implemented (see `docs/agent-runner-protocol.md` "Status"). `MockAgentRunner` unit-tests orchestrator behavior. `ClaudeCodeAgentRunner`'s own protocol against the real `claude` CLI is covered by `src/agent/claudeCodeRunner.test.ts` (fake-stub, deterministic) and `claudeCodeRunner.live.test.ts` (real CLI, opt-in — SPEC.md 17.8 style). |
| 17.6 Observability                              | `src/logging/logger.test.ts`                                |
| 17.7 CLI and Host Lifecycle                     | `src/cli.test.ts`                                            |
| 17.8 Real Integration Profile                   | `src/tracker/linear.schema.test.ts`, `src/agent/claudeCodeRunner.live.test.ts` — both opt-in via env var, both need no stored credentials for the specific thing they check (schema validity / CLI wiring), not full end-to-end dispatch. |

Known gap: SPEC.md 8.4's "slot exhaustion requeues retries with explicit error reason" path
(`onRetryTimer` finding no available slots) is implemented in
`src/orchestrator/orchestrator.ts` but is not covered by a dedicated integration test — reliably
driving that exact race without flakiness needs either fake timers or an exposed test-only tick
hook, neither of which was added in this pass. The underlying slot-accounting functions it depends
on (`availableStateSlots`, `noAvailableSlots`) are unit tested in `selection.test.ts`.
