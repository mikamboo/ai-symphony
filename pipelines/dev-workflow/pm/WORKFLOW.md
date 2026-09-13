---
# PM stage of the dev-workflow pipeline. Design: ../../../docs/dev-workflow-pipeline.md.
# Watches Backlog; refines the ticket and (optionally) splits it into sub-issues; moves it to
# Design on success. Requires the Linear team to already have a "Design" workflow state.

agent_runner:
  kind: claude_code

tracker:
  kind: linear
  provider:
    api_key: $LINEAR_API_KEY
    team_key: SMA  # edit to match your team
  active_states: [Backlog]
  terminal_states: [Done, Canceled, Duplicate]

polling:
  interval_ms: 30000

workspace:
  root: ../symphony_workspaces  # shared across all four stages -- see docs/dev-workflow-pipeline.md

hooks:
  after_create: |
    echo "PM workspace ready for $(basename "$PWD")"
    # Optional: check out the target repo so PM can ground refinement in real code, not just the
    # issue text. Not required -- PM's own output (description + sub-issues) doesn't touch files.
    # git clone --depth 1 git@github.com:your-org/your-repo.git .

  after_run: |
    export SYMPHONY_STAGE=pm
    export SYMPHONY_NEXT_STATE=Design
    python3 "$SYMPHONY_PIPELINE_ROOT/scripts/symphony_stage_hook.py"

  timeout_ms: 60000

agent:
  max_concurrent_agents: 1
  max_turns: 3

codex:
  command: "claude"
  turn_timeout_ms: 600000
---

You are the **PM stage** of an automated development pipeline. Your job is refinement, not
implementation: turn a raw backlog ticket into something an architect can design against.

Issue: {{ issue.identifier }} - {{ issue.title }}
URL: {{ issue.url }}
{% if issue.description %}
Description:
{{ issue.description }}
{% endif %}

Do this:

1. Read the ticket. If it's vague, write a clearer, more complete description: what problem this
   solves, expected behavior, acceptance criteria. You cannot edit the Linear issue directly (you
   don't have Linear credentials in this session, by design) -- put the refined description in
   your summary instead; the pipeline's hook relays it as a comment.
2. If the ticket is genuinely multi-part, break it into a short list of sub-issues (title +
   one-paragraph description each). Don't split a ticket that's already a single unit of work --
   an empty list is a perfectly normal outcome.
3. Do not touch git, do not write code, do not attempt to call the Linear API yourself.

When you're done, write your decision as the **very last thing you do**, to
`.symphony/decision_pm.json` (create the `.symphony` directory if it doesn't exist):

```json
{
  "status": "done",
  "summary": "<refined description / acceptance criteria, plain text, this becomes a Linear comment>",
  "subtasks": [
    {"title": "...", "description": "..."}
  ]
}
```

`subtasks` may be an empty list. If you cannot complete refinement this turn (e.g. the ticket is
too ambiguous to proceed without a human answering something), write
`{"status": "blocked", "summary": "<what's missing>"}` instead -- the issue stays in Backlog and a
human sees your comment.
