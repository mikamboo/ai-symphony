# CLAUDE.md

Orientation for a fresh agent session on this repo. Keep this file thin — an index of non-obvious
decisions, not a copy of `SPEC.md` or `README.md`. Update it when scope/gaps/rules below change;
don't let it drift.

## What this is

TypeScript/Node implementation of **Symphony** (spec in `SPEC.md`): a daemon that polls an issue
tracker, creates a per-issue workspace, and runs a coding-agent session per issue. Scope for this
implementation: **Core Conformance only** (SPEC.md §18.1) — not the OPTIONAL HTTP server,
provider-native tracker tools, session persistence across restarts, or Appendix A.

Full status table, directory map, dev/security notes: `README.md`.

## Decisions already made (don't re-litigate without asking)

- **Agent runner** is deliberately decoupled from the OpenAI Codex app-server protocol via the
  `AgentRunner` interface (`src/agent/runner.ts`). `SubprocessAgentRunner` speaks Symphony's own
  reference JSON protocol (`docs/agent-runner-protocol.md`), not a Codex client — don't "fix" it
  to match Codex's wire format; that was an explicit choice.
- **Tracker adapter shipped**: Linear only (`src/tracker/linear.ts`, read-only), plus an in-memory
  mock for tests.
- **Trust posture**: high-trust environment assumed. No operator-approval channel exists;
  `turn.input_required` is treated as a failed turn. Adding an approval flow changes the
  documented security posture — discuss first.

## The one architecture rule to protect

Orchestration logic (`src/orchestrator/`) only depends on the `TrackerAdapter` and `AgentRunner`
interfaces, never a concrete provider. If a change reaches into `src/orchestrator/` to special-case
Linear or the subprocess runner, that's a sign the interface is wrong, not that the orchestrator
needs a special case.

## Known gaps

- SPEC.md §8.4's slot-exhaustion retry-requeue path (`onRetryTimer` in
  `src/orchestrator/orchestrator.ts`) has no dedicated integration test — needs fake timers or a
  test-only tick hook. The slot math it depends on (`availableStateSlots`, `noAvailableSlots`) is
  unit tested.
- Not implemented at all (SPEC.md §18.2/13.7/Appendix A, out of scope for this pass): HTTP status
  server, provider-native tracker write tools, retry-queue/session persistence across restarts,
  SSH worker extension.

## Reading SPEC.md efficiently

It's 2312 lines and mostly stable. Grep `^## ` / `^### ` for the section you need rather than
reading it whole. Test files next to the code you're touching (`src/**/*.test.ts`) usually restate
the spec requirement in plain language too.
