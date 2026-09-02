# Examples

Three ready-to-run `WORKFLOW.md` files. Each is a complete runtime config for the Symphony CLI
(`pnpm run dev -- <path>` from the repo root) — see the main [`README.md`](../README.md) for
install/build steps first.

All three default to `agent_runner.kind: subprocess` (or omit it, same effect) except
`claude-code/WORKFLOW.md`, which sets it explicitly. `agent_runner.kind` is a Symphony-CLI-only
convenience, not part of SPEC.md's core schema — see
[`docs/agent-runner-protocol.md`](../docs/agent-runner-protocol.md) for what actually runs today
under each `kind` (short version: the default speaks Symphony's own reference protocol, not any
real coding agent's).

## `mock/WORKFLOW.md` — lifecycle smoke test

```bash
pnpm run dev -- examples/mock/WORKFLOW.md
```

Uses `tracker.kind: mock`, the in-memory `MockTrackerAdapter` (`src/tracker/mock.ts`). It starts
with **zero seeded issues** and there is currently no CLI flag or `WORKFLOW.md` field to seed one,
so nothing ever dispatches — you'll see `service.started` and periodic `snapshot` log lines
(`running=0 retrying=0`), then a clean shutdown on `Ctrl-C`.

Use this to exercise the parts that don't need a real tracker: startup validation, the poll loop,
`WORKFLOW.md` live-reload (edit the file while it's running and watch for a `workflow.reloaded` log
line), and graceful shutdown. It is **not** a functional dispatch demo — for that, use the Linear
example below, or drive `MockTrackerAdapter.seed(...)` directly from a test/script instead of the
CLI (see `src/tracker/mock.test.ts` for the pattern).

## `linear/WORKFLOW.md` — real dispatch against Linear

```bash
export LINEAR_API_KEY=lin_api_...
pnpm run dev -- examples/linear/WORKFLOW.md
```

Requires a real Linear API key (see [`docs/adapters/linear.md`](../docs/adapters/linear.md) for
scoping it to a team/project) and at least one issue that is: in the `Todo` or `In Progress` state,
carries the `symphony` label, and lives in the `ENG` team (edit `team_key` and `required_labels` in
the front matter to match your workspace before running). When those conditions are met, Symphony
dispatches it: creates `examples/linear/symphony_workspaces/<identifier>/` (workspace.root here is
relative to this WORKFLOW.md's own directory, not the repo root — SPEC.md 5.3.3), runs
`hooks.after_create`, and starts a coding-agent session there. This example doesn't set
`agent_runner.kind`, so it uses the default `SubprocessAgentRunner` — which speaks Symphony's own
reference protocol, not a real coding agent's (see `docs/agent-runner-protocol.md`). To actually
drive a real agent against a real dispatched issue, add `agent_runner: {kind: claude_code}` and
`codex: {command: claude}` to this file, the same way `claude-code/WORKFLOW.md` does.

Every front-matter field is commented inline; treat it as the field-reference example, and
`SPEC.md` §5.3 / §6.4 as the exhaustive spec if a field's behavior is unclear.

## `claude-code/WORKFLOW.md` — real coding-agent integration (mock tracker)

```bash
pnpm run dev -- examples/claude-code/WORKFLOW.md
```

Same "mock tracker, nothing ever dispatches" limitation as `mock/WORKFLOW.md` above — this proves
out `agent_runner.kind: claude_code` selection and config wiring at startup (look for
`startup.agent_runner_selected kind=claude_code` in the logs), not an end-to-end run. To see
`ClaudeCodeAgentRunner` actually drive a turn, pair its `agent_runner`/`codex` front matter with
`linear/WORKFLOW.md`'s tracker config instead, or seed `MockTrackerAdapter` from a script (see
`src/tracker/mock.test.ts`).

Requires the `claude` CLI on `PATH` (or an absolute path in `codex.command`) and running Symphony
somewhere the `claude` login/credentials are already set up. See the class-level doc comment in
[`src/agent/claudeCodeRunner.ts`](../src/agent/claudeCodeRunner.ts) for exactly what this runner
does and doesn't do (permission mode, session continuation, what wasn't verified).

## Cleaning up

All three examples set `workspace.root: ./symphony_workspaces`, which resolves relative to each
`WORKFLOW.md`'s own directory (`examples/mock/symphony_workspaces`,
`examples/linear/symphony_workspaces`, `examples/claude-code/symphony_workspaces` — not the repo
root). It's gitignored but not auto-deleted; remove it between runs if you want a clean slate:

```bash
rm -rf examples/*/symphony_workspaces
```
