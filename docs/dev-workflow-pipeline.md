# Multi-agent SDLC pipeline (design doc — not implemented)

Status: **design only**. Nothing under `pipelines/` exists yet. This documents the process so it
can be reviewed before any `WORKFLOW.md` or hook script gets written, per the "describe before
coding" ask that started this doc. See `docs/ROADMAP.md` §5 for where this sits among other
deferred decisions.

## Goal

A ticket lands in Linear. Four Symphony processes — PM, Architect, Dev, QA — each watching one
pipeline state, relay it through refinement → design → implementation → review with no human
action required in the common case. The only human-in-the-loop surface is the code PR itself
(normal GitHub review, which nothing here blocks on) and a `Blocked` escape valve if the QA↔Dev
bounce loop doesn't converge.

This is a deliberate simplification from an earlier draft that used a Linear-side "human gate"
state before Dev. That added a second review mechanism (a Linear state transition meaning
"approved") on top of the one review mechanism engineers already use (PR review) — cut for being
non-obvious without adding safety, not because human oversight was cut.

## Why custom states, not labels

Each of the four stages gets its own Linear workflow state. An issue is dispatch-eligible for
exactly one stage at a time (`tracker.active_states` in that stage's `WORKFLOW.md` names only its
own state), so there's no need for a label to disambiguate two stages sharing a state — the
earlier label-based draft only needed a label at all because it tried to fit five pipeline
positions into Linear's four default states. Custom states remove that constraint and, as a
side effect, give the visual "card moves through columns" effect on a standard Linear board
(grouped by state, the default view) for free — no board configuration needed.

Linear workflow states must exist in the team's settings before this runs; creating
`Design`, `Development`, `Review`, `Blocked` (rename `Todo`→`Development` and `In Review`→`Review`
if you'd rather reuse two of the defaults) is a one-time manual setup step, not something Symphony
provisions.

## State relay

| State | Stage that dispatches on it | `required_labels` | On success | On failure |
|---|---|---|---|---|
| `Backlog` | PM | none | Refine description + acceptance criteria; create Linear **sub-issues** per implementation unit if the ticket is multi-part. Comment the plan. → move to `Design` | Leave in `Backlog`, comment what's missing, worker exits normally (re-polled next tick — see "Retry vs. bounce" below) |
| `Design` | Architect | none | Write the technical design as an issue comment (approach, files touched, risks). → move to `Development` | Leave in `Design`, comment the blocker |
| `Development` | Dev | none | Implement, commit, push a branch, open a PR referencing the issue. Comment the PR link. → move to `Review` | Leave in `Development`, comment the blocker |
| `Review` | QA | none | Review the PR diff (correctness, tests, style). **Pass**: approve + merge the PR, comment the outcome → move to `Done`. **Fail**: request changes on the PR with specific comments, mirror a short summary onto the issue → move back to `Development` | (failure *is* the bounce-to-Dev path above, not a separate case) |
| `Done` | — | — | terminal | — |
| `Blocked` | — | — | terminal until a human manually moves the issue out | — |

Sub-issues Linear creates from PM's breakdown are ordinary issues and re-enter this same table
independently at `Backlog` (or wherever PM leaves them) — no separate mechanism needed for
subtask-level granularity.

No label is used anywhere in this design. If a later revision needs to skip an issue from
automation entirely (e.g. a human is handling it manually), an opt-out label like `no-symphony`
checked as an *absence* in each stage's `required_labels`-equivalent would be the natural
extension — not built now, not needed for the common path.

## Design stage has no PR of its own

Only `Development`→`Review` produces a PR. `Design`'s output is a plain issue comment, not a
document reviewed via diff — there's nothing to diff yet at that point, and adding a second
PR+merge cycle before code exists would reintroduce the "second review mechanism" problem this
design deliberately avoided for the human gate. If design artifacts should themselves be versioned
and reviewed as a PR (e.g. `docs/design/<identifier>.md` in the target repo, merged the same way
code is), that's a one-line change to the `Design` row of the table above — flag it and this doc
gets revised before any code is written, per the same "describe first" rule that produced it.

## Bounce loop and the `Blocked` escape valve

QA failure sends the issue back to `Development` — Dev's own dispatch condition
(`active_states: [Development]`) fires again automatically on the next poll, so the retry is free
and needs no extra signal. To keep a broken loop from running forever:

- Each issue's persisted workspace (SPEC.md workspace reuse — keyed by `issue.identifier`, already
  reused across the whole Dev↔QA bounce since both stages operate in the same directory) gets a
  small `​.symphony/pipeline_state.json` file the shared hook script reads and increments:
  `{"qa_bounce_count": N}`.
- On a QA failure, the hook increments the counter *before* checking it. If `N` exceeds a
  configured cap (proposed default: 3), instead of moving back to `Development` the hook moves the
  issue to `Blocked`, comments why (last QA failure reason + bounce count), and stops. Nothing
  dispatches on `Blocked` — a human has to look at the PR/issue and manually move it back to
  `Development` (or `Design`, if the problem is architectural) to resume, which also resets the
  counter file for that next attempt.
- The same counter file mechanism is reusable for `Backlog`/`Design` self-failures (a stage that
  can't make progress on its own input) if repeated retries there turn out to need capping too —
  not built now since those are worker-exits-normally retries (re-polled, no bounce partner),
  which is a materially different failure mode than the QA↔Dev ping-pong.

## Retry vs. bounce (two different "try again" paths — don't conflate them)

- **Retry** (PM/Architect/Dev/QA fails to make progress on the *first* pass): the worker exits
  normally without moving the Linear state; the issue is simply re-polled and re-dispatched to the
  *same* stage next tick, per Symphony's existing continuation/retry behavior (SPEC.md 7.1,
  `agent.max_turns`, `agent.max_retry_backoff_ms`). No pipeline-specific logic needed here — this
  is just how Symphony already works.
- **Bounce** (QA explicitly rejects Dev's *completed* output): a deliberate state transition
  *backward* in the relay (`Review` → `Development`), capped by the counter above. This is
  pipeline-specific behavior the shared hook implements; it doesn't exist in core Symphony.

## Cross-stage handoff convention

Stages share a workspace (same `workspace.root` keyed by `issue.identifier`) across the whole
relay, so file-based handoff needs no new transport — later stages can just read files earlier
stages left behind, alongside the Linear comment trail:

- `.symphony/pipeline_state.json` — bounce counter (above), machine-owned, not agent-owned.
- Design's comment and Dev's own repo checkout are enough context for Dev and QA respectively;
  no additional handoff file is required beyond what's already proposed unless a stage's prompt
  turns out to need more structure than a comment provides (e.g. QA wanting a machine-readable
  pass/fail from Dev's own self-check) — deferred until a concrete need shows up rather than
  speculatively built now.

## Git / PR mechanics (Dev and QA)

Same credential-isolation pattern already used for Linear writes (`examples/WORKFLOW.example.md`):
the coding agent never holds the token that can push or merge. `hooks.after_run` on `Development`
does the git work (branch, commit, push, open PR via the GitHub API) using a `GITHUB_TOKEN` env
var that's present for the hook (full `process.env` inheritance, per
`docs/workflow-config.md`/`src/workspace/hooks.ts`) but stripped from the agent child process the
same way `LINEAR_API_KEY` already is. `hooks.after_run` on `Review` does the PR review/merge or
request-changes call the same way. The agent's own role in both cases is limited to writing the
code / producing the review comments as plain output the hook then relays to GitHub — mirroring
exactly how the existing example keeps Linear writes host-side.

## Per-stage model selection

`ClaudeCodeAgentRunner` has no `--model` plumbing yet (`src/agent/claudeCodeRunner.ts` always uses
the CLI's own default). Cheaper/faster models make sense for PM and QA (structured,
narrower-scoped work); a stronger model for Architect and Dev (design judgment, larger diffs).
Adding a `codex.model` (or `agent_runner.model`) pass-through field is a small, isolated change —
proposed for whenever this pipeline actually gets implemented, not blocking the design.

## File layout (proposed)

```
pipelines/dev-workflow/
  pm/WORKFLOW.md
  architect/WORKFLOW.md
  dev/WORKFLOW.md
  qa/WORKFLOW.md
  scripts/symphony_stage_hook.py   # shared hook: state transition + bounce-counter logic,
                                    # imported/invoked identically by all four WORKFLOW.md's
                                    # hooks.after_run, parameterized by target state name
  run-all.sh                       # backgrounds all four `pnpm run dev -- .../WORKFLOW.md`
docs/dev-workflow-pipeline.md      # this file
```

## Running four concurrent processes

Each stage is an independent, lightweight Symphony daemon process — nothing here needs a process
manager. `run-all.sh` backgrounds all four `pnpm run dev -- pipelines/dev-workflow/<stage>/WORKFLOW.md`
invocations and traps `SIGINT` to stop all four together. `docker-compose`/`pm2`/`systemd` are
reasonable production alternatives if/when this moves past local testing, but not needed to
validate the design.

## Open items before implementation

1. Whether `Design` gets its own PR (see "Design stage has no PR of its own" above) — confirm or
   revise before writing `architect/WORKFLOW.md`.
2. Exact GitHub API calls in `scripts/symphony_stage_hook.py` (branch creation, PR open, PR
   review/merge, request-changes) need the same live-schema verification discipline already
   applied to every Linear GraphQL call in this repo (`docs/adapters/linear.md` "Real integration
   profile") before being trusted — propose-then-verify, not written from memory.
3. `codex.model` plumbing in `ClaudeCodeAgentRunner` (needed for per-stage model selection above)
   is new runner code, not just pipeline config — small but real implementation work.
4. Bounce cap default (proposed: 3) and whether `Backlog`/`Design` retries need their own cap —
   confirm before hardcoding either.
