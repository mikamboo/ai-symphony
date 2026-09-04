---
# agent_runner is a Symphony-CLI-only extension, not part of SPEC.md's core schema (see
# src/agent/registry.ts). "claude_code" selects ClaudeCodeAgentRunner instead of the default
# SubprocessAgentRunner reference implementation.
agent_runner:
  kind: claude_code

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
  # Reinterpreted by ClaudeCodeAgentRunner: the bare `claude` binary name/path, not a full shell
  # command line (see src/agent/claudeCodeRunner.ts). Point at an absolute path if `claude` isn't
  # on PATH for the process running Symphony.
  command: "claude"
  turn_timeout_ms: 300000
---

Work on {{ issue.identifier }}: {{ issue.title }}.
