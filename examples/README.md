# Examples

Four `WORKFLOW.md` files. Each is a complete runtime config for the Symphony CLI
(`pnpm run dev -- <path>` from the repo root) — see the main [`README.md`](../README.md) for
install/build steps first, and [`docs/workflow-config.md`](../docs/workflow-config.md) for what
every field below actually does, its default, and its failure mode.

Three (`mock/`, `linear/`, `claude-code/`) are narrow, runnable demos of one piece each. The fourth,
[`WORKFLOW.example.md`](./WORKFLOW.example.md), is different in kind: a complete, safe, real
Linear + real Claude Code template meant to be copied — see its own section below.

The three demos default to `agent_runner.kind: subprocess` (or omit it, same effect) except
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
carries the `symphony` label, and lives in whatever team `team_key` in the front matter names
(edit `team_key` and `required_labels` to match your own workspace before running). When those
conditions are met, Symphony
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

## `WORKFLOW.example.md` — the real template to copy

```bash
cp examples/WORKFLOW.example.md /path/to/wherever/you/run/symphony/WORKFLOW.md
# edit team_key (and required_labels/active_states/terminal_states if yours differ)
export LINEAR_API_KEY=lin_api_...
pnpm run dev -- /path/to/wherever/you/run/symphony/WORKFLOW.md
```

Real Linear tracker + real `ClaudeCodeAgentRunner`, deliberately scoped down to the smallest thing
that proves the whole pipeline works end to end: **one comment posted on the issue, nothing else**.
Worth understanding *how* that's achieved before you build on top of it:

- **The agent never writes to Linear.** The prompt tells Claude to only investigate and summarize,
  never to touch the tracker itself — and it *couldn't* even if the prompt failed to convince it:
  `ClaudeCodeAgentRunner` strips `LINEAR_API_KEY` from the agent's process environment before
  spawning it (SPEC.md 15.3; see `docs/agent-runner-protocol.md`). The actual comment is posted by
  `hooks.after_run` — a small Python script (stdlib only, no dependencies beyond `python3` on the
  machine running Symphony) that runs **host-side**, after the agent turn finishes, using
  Symphony's own credential. This is the one architectural fact this whole file demonstrates: a
  tracker write can happen without the coding agent ever holding write access.
- **It won't re-comment or re-dispatch.** After posting, the hook removes the `symphony` label
  (`issueRemoveLabel`) that gated dispatch in the first place, so the issue drops out of
  `required_labels` matching on the next poll. It also checks existing comments for a marker
  string first, as a defense-in-depth backstop against the rare case where label removal races a
  retry. Skip both mechanisms and a naive copy of this pattern will re-invoke the agent — and
  re-spend real API cost — on the same issue every `polling.interval_ms` forever, as long as it
  stays in an active state.
- **"No code changes" is prompt-level, not technically enforced.** `ClaudeCodeAgentRunner` doesn't
  currently expose a way to configure `claude`'s `--tools`/`--disallowedTools`/`--restricted` flags
  from `WORKFLOW.md` (see `docs/ROADMAP.md`) — the agent has real file-editing tools available in
  this workspace and is only asked not to use them. Fine for a first supervised test; not a
  substitute for `--restricted`-style enforcement if you're pointing this at issues you don't
  trust.
- **Every GraphQL query/mutation in the hook was checked against Linear's live schema** the same
  way the adapter fix in `docs/adapters/linear.md` was — with a throwaway token, confirming a
  plain auth error rather than `GRAPHQL_VALIDATION_FAILED` — not written from memory. If you modify
  the hook, re-verify the same way (`docs/adapters/linear.md` "Real integration profile" explains
  why that matters).

## Cleaning up

All four examples set `workspace.root: ./symphony_workspaces`, which resolves relative to each
`WORKFLOW.md`'s own directory (`examples/mock/symphony_workspaces`,
`examples/linear/symphony_workspaces`, `examples/claude-code/symphony_workspaces`,
`examples/symphony_workspaces` for `WORKFLOW.example.md` if run in place — not the repo root).
It's gitignored but not auto-deleted; remove it between runs if you want a clean slate:

```bash
rm -rf examples/*/symphony_workspaces examples/symphony_workspaces
```
