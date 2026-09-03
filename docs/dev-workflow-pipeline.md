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
| `Design` | Architect | none | Write the architecture design doc + ADR(s) as files in the shared workspace (not committed yet — see below). Comment a summary. → move to `Development` | Leave in `Design`, comment the blocker |
| `Development` | Dev | none | Implement, then commit **the code together with Architect's design doc + ADR file(s)** in one branch/PR referencing the issue. Comment the PR link. → move to `Review` | Leave in `Development`, comment the blocker |
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

## Architecture design + ADRs — written by Architect, committed by Dev

Confirmed: design and ADRs are real, versioned artifacts, not just Linear comments — but they get
**one** PR, not two. Architect writes files into the shared per-issue workspace during `Design`;
Dev picks them up and commits them alongside the code change during `Development`, so the single
PR that goes to `Review` contains design + ADR + implementation in one diff. This keeps "review on
PR" as the pipeline's one review mechanism (per the goal above) instead of adding a second
PR+merge cycle before code exists, which would have reintroduced the same "second review
mechanism" problem cut for the human gate.

Paths, in the **target repository** being developed (not this Symphony repo, and not the pipeline
config below — these land wherever `hooks.after_create` checks the target repo out to, same as
`examples/WORKFLOW.example.md`'s optional `git clone`):

- `docs/architecture/<identifier>.md` — one doc per ticket: approach, files touched, risks,
  alternatives considered. Free-form Markdown, not a fixed template.
- `docs/adr/NNNN-<slug>.md` — one file per architecturally-significant decision the ticket makes
  (not every ticket produces one). Sequential `NNNN` numbering across the whole repo, MADR-lite
  sections: `Status` (Proposed/Accepted/Superseded), `Context`, `Decision`, `Consequences`. Because
  numbering is repo-global, Architect's hook needs read access to the target repo's existing
  `docs/adr/` at `Design` time to pick the next number — a small but real reason `Design`'s
  `hooks.before_run` (or `after_create`) needs the same repo checkout Dev already does, not just a
  bare workspace.
- Both are ordinary files in Dev's own commit — no separate write-access or credential concern
  beyond what Dev already has (it's already pushing a branch and opening a PR).

## UI/UX design and artifacts

Recommendation: don't force every ticket through a UI step, and don't reach for a real design tool
(Figma etc.) — a coding agent can't drive one today, and most tickets in a backend-shaped pipeline
like this won't need one. Two-tier approach instead:

- **Default**: if a ticket touches user-facing surface, Architect adds a "UI/UX" section to the
  same `docs/architecture/<identifier>.md` — screens/components touched, states, user flow as a
  table or short prose. No new file, no new tooling, judgment call left to Architect's prompt
  (skip the section entirely for backend-only tickets).
- **When it's worth more than prose**: for a ticket where a visual actually clarifies the change,
  Architect (or Dev, since it's just a file write) commits a self-contained static
  `design/ui/<identifier>/mockup.html` — plain HTML/CSS, no build step, viewable straight from the
  repo or the PR's file diff. This is well within what the coding agent can already do (it's a
  file write, same as any other), unlike driving an actual design tool.
- **Out of scope for the agent**: high-fidelity/Figma-grade visual design stays a human artifact,
  linked from the issue or PR description when someone attaches one. The pipeline doesn't wait on
  it and doesn't try to produce it — flagged here as a deliberate boundary, not an oversight.

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

1. ~~Whether `Design` gets its own PR~~ — resolved: no, single PR at `Development`, see above.
2. `Design` now needs a target-repo checkout to read `docs/adr/` for numbering, not just a bare
   workspace — confirm `hooks.after_create` (or `before_run`) on `architect/WORKFLOW.md` should
   clone/checkout the same way `dev/WORKFLOW.md` does, rather than Architect writing files with no
   repo context.
3. Exact GitHub API calls in `scripts/symphony_stage_hook.py` (branch creation, PR open, PR
   review/merge, request-changes) need the same live-schema verification discipline already
   applied to every Linear GraphQL call in this repo (`docs/adapters/linear.md` "Real integration
   profile") before being trusted — propose-then-verify, not written from memory.
4. `codex.model` plumbing in `ClaudeCodeAgentRunner` (needed for per-stage model selection above)
   is new runner code, not just pipeline config — small but real implementation work.
5. Bounce cap default (proposed: 3) and whether `Backlog`/`Design` retries need their own cap —
   confirm before hardcoding either.
