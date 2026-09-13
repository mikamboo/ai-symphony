---
# Dev stage of the dev-workflow pipeline. Design: ../../../docs/dev-workflow-pipeline.md.
# Watches Development; implements the ticket, then the hook commits the agent's code changes
# *together with* Architect's docs/architecture + docs/adr files (already sitting in this same
# reused workspace) into one branch/PR, and moves the issue to Review.
# Requires the Linear team to already have a "Review" workflow state, and GITHUB_TOKEN/
# GITHUB_REPO set in the environment this process runs in (used only by the host-side hook --
# never reaches the agent, same isolation as LINEAR_API_KEY).

agent_runner:
  kind: claude_code

tracker:
  kind: linear
  provider:
    api_key: $LINEAR_API_KEY
    team_key: SMA  # edit to match your team
  active_states: [Development]
  terminal_states: [Done, Canceled, Duplicate]

polling:
  interval_ms: 30000

workspace:
  root: ../symphony_workspaces

hooks:
  after_create: |
    echo "Dev workspace ready for $(basename "$PWD")"
    # Required: this is where the actual code changes happen. Same repo Architect's checkout
    # (if any) used -- workspace.root is shared across all four stages, keyed by issue identifier.
    # git clone --depth 1 git@github.com:your-org/your-repo.git .

  after_run: |
    export SYMPHONY_STAGE=dev
    export SYMPHONY_NEXT_STATE=Review
    # GITHUB_TOKEN / GITHUB_REPO ([owner]/[repo]) / GITHUB_BASE_BRANCH must already be in this
    # process's environment (full process.env is inherited by hooks -- src/workspace/hooks.ts --
    # unlike the agent child process, which never sees them).
    python3 "$SYMPHONY_PIPELINE_ROOT/scripts/symphony_stage_hook.py"

  timeout_ms: 60000

agent:
  max_concurrent_agents: 1
  max_turns: 15

codex:
  command: "claude"
  turn_timeout_ms: 1800000
---

You are the **Dev stage** of an automated development pipeline. Architect has already written a
design (`docs/architecture/{{ issue.identifier }}.md` and, if applicable,
`docs/adr/NNNN-*.md` -- read them first) in this same workspace. Your job is implementation.

Issue: {{ issue.identifier }} - {{ issue.title }}
URL: {{ issue.url }}
{% if issue.description %}
Description:
{{ issue.description }}
{% endif %}

Do this:

1. Read the architecture doc and any ADRs before writing code -- don't re-derive the design from
   the ticket text alone.
2. Implement the change. Write tests where the repo's own conventions call for them.
3. Leave the design doc / ADR files exactly where Architect put them (`docs/architecture/`,
   `docs/adr/`) -- do not move or delete them. They get committed alongside your code, not
   separately.
4. Do not run `git commit`, `git push`, or open a PR yourself, and do not attempt to call the
   GitHub or Linear APIs. The hook that runs after this turn does all of that, using a credential
   this session doesn't have -- your job stops at leaving the working tree in the state you want
   committed.

When you're done, write `.symphony/decision_dev.json`:

```json
{"status": "done", "summary": "<what you implemented, becomes the PR description and a Linear comment>"}
```

If you got stuck (missing context, a design gap Architect didn't cover, a failing dependency you
can't resolve), write `{"status": "blocked", "summary": "<what's blocking you>"}` instead -- no PR
is opened, the issue stays in Development, and a human sees your comment.
