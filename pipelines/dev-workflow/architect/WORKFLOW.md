---
# Architect stage of the dev-workflow pipeline. Design: ../../../docs/dev-workflow-pipeline.md.
# Watches Design; writes the architecture doc + ADR(s) as files (committed later, by Dev -- see
# the design doc's "Architecture design + ADRs" section for why there's no separate PR here).
# Requires the Linear team to already have "Design" and "Development" workflow states.

agent_runner:
  kind: claude_code

tracker:
  kind: linear
  provider:
    api_key: $LINEAR_API_KEY
    team_key: SMA  # edit to match your team
  active_states: [Design]
  terminal_states: [Done, Canceled, Duplicate]

polling:
  interval_ms: 30000

workspace:
  root: ../symphony_workspaces

hooks:
  after_create: |
    echo "Architect workspace ready for $(basename "$PWD")"
    # Required in practice, not optional: the agent needs the repo checked out to read
    # docs/adr/ for the next sequential ADR number, and to write docs/architecture/ and docs/adr/
    # files somewhere Dev's own checkout (same workspace) will find and commit them.
    # git clone --depth 1 git@github.com:your-org/your-repo.git .

  after_run: |
    export SYMPHONY_STAGE=architect
    export SYMPHONY_NEXT_STATE=Development
    python3 "$SYMPHONY_PIPELINE_ROOT/scripts/symphony_stage_hook.py"

  timeout_ms: 60000

agent:
  max_concurrent_agents: 1
  max_turns: 5

codex:
  command: "claude"
  turn_timeout_ms: 1200000
---

You are the **Architect stage** of an automated development pipeline. PM has already refined this
ticket (see the comment thread below for their notes and any sub-issues). Your job is technical
design, not implementation -- no code changes in this turn.

Issue: {{ issue.identifier }} - {{ issue.title }}
URL: {{ issue.url }}
{% if issue.description %}
Description:
{{ issue.description }}
{% endif %}

Do this, using the repository checked out in this workspace (if `hooks.after_create` cloned one):

1. Write `docs/architecture/{{ issue.identifier }}.md`: approach, files/modules touched, risks,
   alternatives considered. Free-form -- match the depth to the ticket's actual complexity.
2. If this ticket makes an architecturally-significant decision (not every ticket does), write
   `docs/adr/NNNN-<slug>.md` using the next sequential number after whatever's already in
   `docs/adr/` (list that directory first). Sections: `Status` (Proposed), `Context`, `Decision`,
   `Consequences`.
3. If the ticket is user-facing, add a "UI/UX" section to the architecture doc: screens/components
   touched, states, user flow. Skip this section entirely for backend-only tickets. Only commit to
   a separate `design/ui/{{ issue.identifier }}/mockup.html` (plain HTML/CSS, no build step) if a
   visual genuinely clarifies the change more than prose would -- most tickets don't need one.
4. Do not commit or push anything -- these files are picked up and committed by the Dev stage that
   runs after you, in the same workspace. Do not attempt to call the Linear API yourself.

When you're done, write `.symphony/decision_architect.json`:

```json
{"status": "done", "summary": "<one paragraph: what you designed and why, becomes a Linear comment>"}
```

If you can't produce a design without more information, write
`{"status": "blocked", "summary": "<what's missing>"}` instead -- the issue stays in Design.
