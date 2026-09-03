# CLAUDE.md

Orientation for a fresh agent session on this repo. Keep this file thin — an index of non-obvious
decisions, not a copy of `SPEC.md` or `README.md`. Update it when scope/gaps/rules below change;
don't let it drift.

## What this is

TypeScript/Node implementation of **Symphony** (spec in `SPEC.md`): a daemon that polls an issue
tracker, creates a per-issue workspace, and runs a coding-agent session per issue. Scope for this
implementation: **Core Conformance only** (SPEC.md §18.1) — not the OPTIONAL HTTP server,
provider-native tracker tools, session persistence across restarts, or Appendix A.

Full status table, directory map, dev/security notes: `README.md`. Detailed §18 conformance
checklist, plans for unfinished items, and the deferred-decisions log: `docs/ROADMAP.md` — check
it before proposing new work, so you don't re-propose something already deferred for a reason.

## Decisions already made (don't re-litigate without asking)

- **Agent runner** is deliberately decoupled from the OpenAI Codex app-server protocol via the
  `AgentRunner` interface (`src/agent/runner.ts`). `SubprocessAgentRunner` speaks Symphony's own
  reference JSON protocol (`docs/agent-runner-protocol.md`), not a Codex client — don't "fix" it
  to match Codex's wire format; that was an explicit choice.
- **Real Codex app-server support does not exist**, despite `codex.command` defaulting to
  `"codex app-server"`. Nobody has implemented a client for Codex's actual protocol — this is not
  a gap someone forgot, it's the same scope decision as the line above. Don't assume it works.
- **`ClaudeCodeAgentRunner`** (`src/agent/claudeCodeRunner.ts`) drives the real `claude` CLI —
  select it via `agent_runner.kind: claude_code` (a Symphony-CLI-only `WORKFLOW.md` extension
  field, `src/agent/registry.ts`, not part of SPEC.md's schema). Its class-level doc comment lists
  exactly what was verified by direct invocation (flags, event shapes, the `acceptEdits`-not-
  `bypassPermissions`-as-root finding) vs. assumed — read that before changing it, and re-verify
  against the installed `claude` version rather than editing from memory if something looks off
  (see `docs/adapters/linear.md`'s "Real integration profile" for why that matters: a
  never-checked-against-the-real-API GraphQL argument shipped once already and broke every Linear
  request).
- **Tracker adapter shipped**: Linear only (`src/tracker/linear.ts`, read-only), plus an in-memory
  mock for tests.
- **Trust posture**: high-trust environment assumed for every shipped runner. No operator-approval
  channel exists anywhere; `SubprocessAgentRunner` fails `turn.input_required` outright,
  `ClaudeCodeAgentRunner` runs with `--permission-mode acceptEdits` (auto-approves file edits and
  tool calls, no human in the loop). Adding an approval flow changes the documented security
  posture — discuss first.

## The one architecture rule to protect

Orchestration logic (`src/orchestrator/`) only depends on the `TrackerAdapter` and `AgentRunner`
interfaces, never a concrete provider. If a change reaches into `src/orchestrator/` to special-case
Linear or the subprocess runner, that's a sign the interface is wrong, not that the orchestrator
needs a special case.

## Known gaps

Full list with plans and status: `docs/ROADMAP.md` §2 and §4. Don't duplicate it here — update
that file instead so there's one place this can go stale.

## Reading SPEC.md efficiently

It's 2312 lines and mostly stable. Grep `^## ` / `^### ` for the section you need rather than
reading it whole. Test files next to the code you're touching (`src/**/*.test.ts`) usually restate
the spec requirement in plain language too.
