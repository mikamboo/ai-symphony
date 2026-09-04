---
tracker:
  kind: mock
  active_states: [Todo]
  terminal_states: [Done]

polling:
  interval_ms: 10000

workspace:
  root: ./symphony_workspaces

agent:
  max_concurrent_agents: 2
  max_turns: 3

codex:
  command: "codex app-server"
---

Work on {{ issue.identifier }}: {{ issue.title }}.
