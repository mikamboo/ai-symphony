# CLAUDE.md

Orientation for a fresh agent session on this repo. Keep this file thin — an index, not a copy
of `SPEC.md` or `README.md`. Update it when status/gaps/rules below change; don't let it drift.

## What this is

TypeScript/Node implementation of **Symphony** (the spec in `SPEC.md`, 2312 lines): a daemon that
polls an issue tracker, creates a per-issue workspace, and runs a coding-agent session per issue.
Scope for this implementation: **Core Conformance only** (SPEC.md §18.1) — not the OPTIONAL HTTP
server, provider-native tracker tools, session persistence across restarts, or Appendix A.

Full status table, directory map, dev/security notes: `README.md`. Read that before re-deriving
anything from `SPEC.md` directly.

## Key decisions already made (don't re-litigate without asking)

- **Language**: TypeScript/Node, ESM (`"type": "module"`).
- **Package manager**: pnpm, pinned via `packageManager` in `package.json`. Not npm/yarn.
- **Agent runner**: deliberately decoupled from the OpenAI Codex app-server protocol via the
  `AgentRunner` interface (`src/agent/runner.ts`). `SubprocessAgentRunner` speaks Symphony's own
  reference JSON protocol, documented in `docs/agent-runner-protocol.md` — it is *not* a Codex
  client. Don't "fix" it to match Codex's wire format; that was an explicit choice, not an
  oversight.
- **Tracker adapter shipped**: Linear (`src/tracker/linear.ts`, read-only, profile in
  `docs/adapters/linear.md`) plus an in-memory `MockTrackerAdapter` for tests/local runs.
- **Trust posture**: high-trust environment assumption. No operator-approval channel exists;
  `turn.input_required` is treated as a failed turn. Don't add approval flows without discussing —
  it changes the documented security posture in the README.

## The one architecture rule to protect

Orchestration logic (`src/orchestrator/`) only depends on the `TrackerAdapter` and `AgentRunner`
interfaces, never a concrete provider. If a change reaches into `src/orchestrator/` to special-case
Linear or the subprocess runner, stop — that's a sign the interface is wrong, not that the
orchestrator needs a special case.

## Working state

- Branch: `claude/symphony-implementation-jmnk6q` → PR
  [mikamboo/ai-symphony#1](https://github.com/mikamboo/ai-symphony/pull/1). Push commits to this
  branch to update that PR; don't open a new one.
- Commands: `pnpm install`, `pnpm run typecheck`, `pnpm test` (70 tests, vitest), `pnpm run build`.
- Known gap (see README "Known gap"): SPEC.md §8.4's slot-exhaustion retry-requeue path
  (`onRetryTimer` in `src/orchestrator/orchestrator.ts`) has no dedicated integration test —
  reliable coverage needs fake timers or a test-only tick hook, neither added yet. The slot-math
  it depends on (`availableStateSlots`, `noAvailableSlots`) *is* unit tested.
- Not implemented at all (SPEC.md §18.2/13.7/Appendix A, out of scope for this pass): HTTP status
  server, provider-native tracker write tools, retry-queue/session persistence across restarts,
  SSH worker extension.

## Before touching orchestrator/tracker/agent code

1. Skim `SPEC.md`'s section header for the area you're touching (grep `^## ` / `^### `) rather than
   reading the whole file — it's long and mostly stable; you likely need one section.
2. Check `src/**/*.test.ts` next to the file you're editing — the test names usually restate the
   spec requirement in plain language, cheaper to read than cross-referencing `SPEC.md` again.
3. Run `pnpm test` before pushing. The CLI lifecycle tests (`src/cli.test.ts`) spawn a real
   subprocess via `node_modules/.bin/tsx` — don't remove that if you touch `src/cli.ts`.
