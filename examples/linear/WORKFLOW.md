---
tracker:
  kind: linear
  provider:
    api_key: $LINEAR_API_KEY
    team_key: SMA
  required_labels: [symphony]
  active_states: [Todo, "In Progress"]
  terminal_states: [Done, Canceled, Duplicate]

polling:
  interval_ms: 30000

workspace:
  root: ./symphony_workspaces
  # root: $SYMPHONY_WORKSPACE_ROOT

hooks:
  after_create: |
    echo "Preparing workspace for $(basename "$PWD")"
    # Example: clone your repo here, e.g.
    # git clone --depth 1 git@github.com:your-org/your-repo.git .
  before_run: |
    echo "About to run agent turn in $(pwd)"
  after_run: |
    echo "Agent turn finished in $(pwd)"
  timeout_ms: 60000

agent:
  max_concurrent_agents: 5
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    "in progress": 3

codex:
  command: "codex app-server"
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

You are working on a Linear issue as part of an automated engineering workflow.

Issue: {{ issue.identifier }} - {{ issue.title }}
URL: {{ issue.url }}
State: {{ issue.state }}
{% if issue.description %}
Description:
{{ issue.description }}
{% endif %}
{% if issue.labels.size > 0 %}
Labels: {% for label in issue.labels %}{{ label }}{% unless forloop.last %}, {% endunless %}{% endfor %}
{% endif %}
{% if issue.blocked_by.size > 0 %}
This issue is blocked by:
{% for blocker in issue.blocked_by %}
- {{ blocker.identifier }} ({{ blocker.state }})
{% endfor %}
{% endif %}
{% if attempt %}
This is retry/continuation attempt {{ attempt }} for this issue.
{% endif %}

Please:
1. Understand the issue and make the necessary code changes.
2. Add or update tests covering your change.
3. Leave the workspace in a state ready for human review.

If the issue is already fully resolved, say so explicitly and make no further changes.
