# Examples

Two ready-to-run `WORKFLOW.md` files. Each is a complete runtime config for the Symphony CLI
(`pnpm run dev -- <path>` from the repo root) — see the main [`README.md`](../README.md) for
install/build steps first.

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
`hooks.after_create`, and starts a coding-agent session there via `codex.command` (default `codex
app-server` — install/point that at whatever `AgentRunner` you're using, see
[`docs/agent-runner-protocol.md`](../docs/agent-runner-protocol.md)).

Every front-matter field is commented inline; treat it as the field-reference example, and
`SPEC.md` §5.3 / §6.4 as the exhaustive spec if a field's behavior is unclear.

## Cleaning up

Both examples set `workspace.root: ./symphony_workspaces`, which resolves relative to each
`WORKFLOW.md`'s own directory (`examples/mock/symphony_workspaces`,
`examples/linear/symphony_workspaces` — not the repo root). It's gitignored but not
auto-deleted; remove it between runs if you want a clean slate:

```bash
rm -rf examples/*/symphony_workspaces
```
