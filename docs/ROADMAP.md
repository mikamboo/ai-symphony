# Roadmap & Decision Log

Living document. Unlike `CLAUDE.md` (thin index, updated only when its own bullets go stale) and
`README.md` (user-facing status), this file is the detailed working record: exact conformance
against every `SPEC.md` §18 checklist item, a concrete plan for each unfinished one, and an
explicit log of decisions deferred for later — so a future session (or you) can see what was
chosen, what wasn't, and why, without re-deriving it from commit archaeology.

**Keep this current.** When a checklist item's status changes, or a deferred decision gets made,
update the relevant row/entry in the same change — don't let this drift into a historical
snapshot.

## 1. Conformance vs. SPEC.md §18.1 (REQUIRED for Core Conformance)

| # | Checklist item (§18.1) | Status | Where |
| - | ----------------------- | ------ | ----- |
| 1 | Workflow path selection: explicit runtime path + cwd default | Done | `src/workflow/loader.ts` (`resolveWorkflowPath`) |
| 2 | `WORKFLOW.md` loader, YAML front matter + prompt body split | Done | `src/workflow/loader.ts` |
| 3 | Typed config layer, defaults + `$VAR` resolution | Done | `src/config/resolve.ts` |
| 4 | Dynamic `WORKFLOW.md` watch/reload/re-apply | Done | `src/workflow/watcher.ts`, `Orchestrator.handleWorkflowChange` |
| 5 | Polling orchestrator, single-authority mutable state | Done | `src/orchestrator/orchestrator.ts` |
| 6 | Tracker adapter: state-list + ID-refresh reads | Done | `src/tracker/linear.ts`, `src/tracker/mock.ts` |
| 7 | Workspace manager: sanitized, collision-resistant paths | Done | `src/workspace/key.ts`, `manager.ts` |
| 8 | Workspace lifecycle hooks (4 hooks) | Done | `src/workspace/hooks.ts` |
| 9 | Hook timeout config | Done | `hooks.timeout_ms`, default 60000 |
| 10 | Coding-agent subprocess client, targeted transport/framing | **Diverges from spec** | Two working runners exist (`SubprocessAgentRunner`, `ClaudeCodeAgentRunner`) but neither speaks the real Codex app-server protocol the spec targets — see §2 row "Real Codex app-server client" below. |
| 11 | `codex.command` config, default `"codex app-server"` | Done, semantics reinterpreted | Field exists; each `AgentRunner` decides what it means (full shell command vs. bare binary) — see `docs/agent-runner-protocol.md` |
| 12 | Strict prompt rendering, `issue` + `attempt` variables | Done | `src/prompt/render.ts` (Liquid, strict mode) |
| 13 | Exponential retry queue, continuation after normal exit | Done | `src/orchestrator/backoff.ts`, `orchestrator.ts` |
| 14 | Configurable retry backoff cap | Done | `agent.max_retry_backoff_ms` |
| 15 | Reconciliation stops runs on terminal/non-active states | Done | `Orchestrator.reconcileRunningIssues` |
| 16 | Workspace cleanup for terminal issues | Done | startup sweep + reconciliation + retry-refresh paths |
| 17 | Structured logs with `issue_id`/`issue_identifier`/`session_id` | Done | `src/logging/logger.ts` |
| 18 | Operator-visible observability | Done (logs only) | No status surface — SPEC.md marks that OPTIONAL |

**Net: 17/18 clean, 1 explicit divergence** (item 10, and by extension item 11's literal
default value) — a scope decision made at the start of this build (see §3), not an oversight.

## 2. §18.2 RECOMMENDED extensions — none started

| Extension | Status | Rough plan if picked up |
| ---------- | ------ | ------------------------ |
| HTTP server (§13.7) | Not started | New `src/http/` module: bind host/port from `server.port` config with CLI `--port` override, expose `Orchestrator.getSnapshot()` read-only over a few endpoints (SPEC.md 13.7 lists the baseline set). Orchestrator itself needs no changes — it already has `getSnapshot()`. Estimate: small, self-contained, ~1 session. |
| Provider-native agent tools | Not started | Needs a decision first: which adapter gets tools, and what they mutate (comments? state transitions?). Linear adapter would grow `agentToolSpecs()`/`executeAgentTool()` per the SPEC.md 10.5 hooks; `AgentRunner` implementations would need to advertise/dispatch them, which neither shipped runner does today. Medium-large: touches the adapter, both runners' protocols, and the orchestrator's session-snapshot binding rule (10.5: tool specs must bind to one session snapshot). |
| Retry-queue / session persistence across restarts | Not started | Requires picking a storage format (SPEC.md explicitly avoids mandating a DB) and deciding what "resume in-flight work after a crash" means for `ClaudeCodeAgentRunner`'s per-turn processes vs. `SubprocessAgentRunner`'s one long-lived one — the two runners would need different resume semantics. Not trivial; needs its own design pass. |
| Observability settings in front matter | Not started | Small: add a `logging` (or similar) front-matter section, thread it through `buildServiceConfig`. Low priority — no concrete need identified yet. |
| Extract common semantic tracker tools | N/A | SPEC.md says only do this "after multiple adapters demonstrate real duplication" — we ship exactly one real adapter (Linear). Revisit if a second tracker adapter is ever added. |

## 3. Known divergence: no real Codex app-server client

Deliberate, not forgotten — full reasoning in `docs/agent-runner-protocol.md` "Status" section
and `CLAUDE.md`. Summary: at the start of this build you chose the abstracted `AgentRunner`
interface over implementing SPEC.md §10's Codex app-server protocol verbatim, so the rest of Core
Conformance could be built and tested without depending on a specific external binary. Two working
runners exist today (`SubprocessAgentRunner` — Symphony's own protocol, works but isn't a real
agent; `ClaudeCodeAgentRunner` — real `claude` CLI, verified against the live binary). A genuine
Codex app-server client remains a from-scratch, not-yet-started integration, comparable in scope
to `ClaudeCodeAgentRunner` or larger (stateful JSON-RPC-style session protocol vs. Claude Code's
simpler one-process-per-turn CLI). See §5 for the open question of whether to build it.

## 4. Known test/behavior gaps (not spec violations, just unfinished coverage)

- **Slot-exhaustion retry-requeue** (SPEC.md §8.4 point 4, `onRetryTimer` in
  `src/orchestrator/orchestrator.ts`): implemented, not covered by a dedicated integration test.
  Needs fake timers or a test-only tick hook to drive deterministically; the slot math it depends
  on (`availableStateSlots`, `noAvailableSlots`) is unit tested in isolation.
- **`AgentSession.sessionId`/`.threadId` snapshot timing**: `Orchestrator` reads these once, right
  after `startSession()` resolves — before any turn has run, so they're `null` even after a turn
  completes for both shipped runners (see `docs/agent-runner-protocol.md`). Cosmetic
  (observability only, doesn't affect dispatch/retry correctness). Fixing it means changing when
  `Orchestrator` re-reads session state, generically, for both runners — a small, well-scoped
  follow-up, not currently done.
- **`is_error`/failure-subtype coverage for `ClaudeCodeAgentRunner`**: only the `subtype: "success"`
  path has been observed against the real CLI; failure subtypes (max-turns-exceeded,
  execution-error) are handled via the `is_error` boolean but not individually confirmed live.

## 5. Open decisions (deferred — ask before starting any of these)

Nothing below is scheduled. Listed so a future session doesn't have to reconstruct "was this
considered?" from scratch.

- **Real Codex app-server client**: build it, or leave `ClaudeCodeAgentRunner` as the only
  verified real integration? No signal yet on whether Codex support is actually wanted.
- **HTTP status server**: worth building for operator visibility, or is structured-log tailing
  enough for how this gets deployed?
- **`agent_runner.kind`'s home**: currently a Symphony-CLI-only `WORKFLOW.md` extension
  (`src/agent/registry.ts`), deliberately kept outside `ServiceConfig`/`buildServiceConfig` so the
  core config layer stays exactly spec-shaped. Promote it into core config if agent-runner
  selection turns out to be a first-class, frequently-changed setting rather than a deploy-time
  choice?
- **DeepSeek / other model-only backends**: no coding-agent CLI exists for these today (see
  `docs/agent-runner-protocol.md`). Only path forward is picking (or building) an agent harness
  that runs on top of one, then writing `AgentRunner` against *that* harness — not something to
  start without picking the harness first.
- **Provider-native tracker write tools**: would let the coding agent mutate Linear directly
  (comments, state transitions) instead of leaving that entirely to whatever tools the agent
  brings on its own. No decision on scope (which mutations, what auth boundary) yet.
- **Session/retry persistence across restarts**: does the deployment target tolerate losing
  in-flight work on a Symphony restart, or does this need solving? Affects how urgent this is.

## 6. Decision history (dated, most recent first)

- **2026-09-03** — Built the PM/Architect/Dev/QA multi-agent SDLC pipeline
  (`pipelines/dev-workflow/`, `docs/dev-workflow-pipeline.md`): four Symphony daemons relaying a
  ticket through custom Linear workflow states (`Backlog → Design → Development → Review → Done`,
  `Blocked` as the bounce-cap escape valve), no Linear-side human gate — the one review checkpoint
  is the eventual PR (design + ADRs + code, one diff, opened by Dev, reviewed/merged by QA). Not
  yet run against a real Linear workspace/GitHub repo; see the doc's "Status" and "What's actually
  verified vs. still open" sections for exactly what has and hasn't been checked.
- **2026-09-02** — Added `ClaudeCodeAgentRunner`, the first real (non-reference) `AgentRunner`
  implementation, verified against the live `claude` CLI. Added `agent_runner.kind` CLI-only
  selection extension. See `docs/agent-runner-protocol.md`.
- **2026-09-02** — Fixed a real Linear adapter bug (`Issue.inverseRelations` was sent an
  argument that doesn't exist on Linear's actual schema, breaking every request with HTTP 400).
  Root cause: written from memory, never checked against the live API. Added
  `linear.schema.test.ts` as a no-credential-needed regression guard, and made "verify against
  the real thing before shipping" an explicit practice going forward (carried into how
  `ClaudeCodeAgentRunner` was built next).
- **2026-09-01** — Switched package manager from npm to pnpm.
- **2026-09-01** — Initial Core Conformance implementation (SPEC.md §18.1) in TypeScript, pnpm,
  with the abstracted `AgentRunner` interface (not the literal Codex app-server protocol),
  Linear as the one real tracker adapter, and `SubprocessAgentRunner` as the reference/test
  runner. See the "Key decisions already made" section of `CLAUDE.md` for the reasoning captured
  at the time.
