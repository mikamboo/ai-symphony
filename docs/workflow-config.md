# `WORKFLOW.md`: format and config reference

`WORKFLOW.md` is the single file that drives a Symphony run: YAML front matter for typed config,
then a Markdown prompt template rendered per issue. This is the exhaustive field-by-field
reference; `SPEC.md` §5/§6 is the normative spec it implements, and
[`examples/`](../examples/) has runnable files to copy from — most directly
[`examples/WORKFLOW.example.md`](../examples/WORKFLOW.example.md), a complete real
Linear + real Claude Code template safe enough to run as-is (see
[`examples/README.md`](../examples/README.md) for what it and the other examples each
demonstrate).

## File location

Resolved in this order (`src/workflow/loader.ts: resolveWorkflowPath`):

1. An explicit path — the CLI's positional argument or `--workflow`/`-w` flag.
2. Default: `WORKFLOW.md` in the process's current working directory.

Missing file → startup fails with a `missing_workflow_file` error (CLI exits non-zero).

## File format

```
---
<YAML front matter>
---
<Markdown prompt template>
```

- If the file doesn't start with a `---` line, there's no front matter: the whole file is the
  prompt template and config is `{}` (every field falls back to its default below).
- The front matter block must decode to a YAML **map** — a list or scalar at the top level is a
  `workflow_front_matter_not_a_map` error.
- Invalid YAML syntax is a `workflow_parse_error`. An opened-but-never-closed `---` block (missing
  the second delimiter) is also a `workflow_parse_error`, not silently treated as "no front
  matter."
- The prompt template (everything after the closing `---`) is trimmed before use.

Workflow load/parse errors block new dispatch entirely (SPEC.md 5.5) — they are not per-attempt
failures.

## Live reload

The resolved `WORKFLOW.md` path is watched (`src/workflow/watcher.ts`); on change, it's re-read
and re-applied without restarting the process (`Orchestrator.handleWorkflowChange`). An invalid
reload (bad YAML, a field that now fails validation) is logged as `workflow.reload_failed` and the
service keeps running on the last-known-good config — it does not crash and does not roll forward
to the broken version. Poll interval and concurrency limits take effect on the *next* tick;
in-flight worker runs keep the config snapshot they started with.

## Front matter fields

All keys below are optional unless marked **required**; omitted sections default entirely. Unknown
top-level keys are ignored (forward-compatible) — this is how the CLI-only `agent_runner` extension
(last section below) coexists with the core schema without being part of it.

### `tracker`

| Key | Type | Default | Notes |
| --- | ---- | ------- | ----- |
| `kind` | string | `""` (invalid) | **Required for dispatch.** Selects the adapter — currently `linear` or `mock` (`src/tracker/registry.ts`). Empty/missing fails preflight validation, not config parsing (so a `WORKFLOW.md` with no tracker at all still loads, it just can't dispatch). |
| `provider` | object | `{}` | Adapter-owned. For `linear`, see [`docs/adapters/linear.md`](./adapters/linear.md) (`api_key`, `team_key`/`team_id`, `project_id`, `page_size`, `endpoint`). |
| `required_labels` | string[] | `[]` | Every listed label must be present (case-insensitive, trimmed) for an issue to be dispatch-eligible. |
| `active_states` | string[] | `[]` | Provider-native state names that make an issue a dispatch candidate. Compared case-insensitively. |
| `terminal_states` | string[] | `[]` | Provider-native state names that trigger workspace cleanup and stop any running worker. |

### `polling`

| Key | Type | Default | Notes |
| --- | ---- | ------- | ----- |
| `interval_ms` | positive integer | `30000` | Time between poll ticks. Reloadable live. |

### `workspace`

| Key | Type | Default | Notes |
| --- | ---- | ------- | ----- |
| `root` | path string | `<os tmpdir>/symphony_workspaces` | `~` and `$VAR_NAME` are expanded. **A relative path resolves relative to the directory containing this `WORKFLOW.md`**, not the process's cwd or the repo root — a common surprise, see `examples/README.md`'s "Cleaning up" section. |

### `hooks`

Shell scripts run via `bash -lc <script>` with the per-issue workspace as `cwd`. See
`src/workspace/hooks.ts`.

| Key | Type | Default | Failure semantics |
| --- | ---- | ------- | ------------------ |
| `after_create` | shell script | none | Runs only when the workspace directory is newly created (not on reuse). **Fatal** to workspace creation — the partially-created directory is removed on failure. |
| `before_run` | shell script | none | Runs before every agent turn. **Fatal** to that attempt. |
| `after_run` | shell script | none | Runs after every attempt (success, failure, or timeout). Failure is logged and ignored. |
| `before_remove` | shell script | none | Runs before workspace deletion for a terminal issue. Failure is logged and ignored; cleanup proceeds regardless. |
| `timeout_ms` | positive integer | `60000` | Applies to all four hooks above. |

### `agent`

| Key | Type | Default | Notes |
| --- | ---- | ------- | ----- |
| `max_concurrent_agents` | positive integer | `10` | Global dispatch slot limit. |
| `max_turns` | positive integer | `20` | Max in-worker turns per attempt before the worker exits normally (issue gets re-polled next tick). |
| `max_retry_backoff_ms` | positive integer | `300000` (5 min) | Caps the exponential backoff formula `min(10000 * 2^(attempt-1), this)` for failure-driven retries. Continuation retries after a *normal* exit always use a fixed 1000 ms, unaffected by this cap. |
| `max_concurrent_agents_by_state` | map\<string, positive integer\> | `{}` | Per-tracker-state override of the global limit. Keys are trimmed + lowercased to match; non-positive or non-numeric values are silently dropped rather than erroring. |

### `codex`

Named for SPEC.md's Codex-centric origin, but **its meaning depends entirely on which
`AgentRunner` is selected** — see the `agent_runner` section below before setting `command`.

| Key | Type | Default | Notes |
| --- | ---- | ------- | ----- |
| `command` | string | `"codex app-server"` | `SubprocessAgentRunner` runs this as a full shell command (`bash -lc <command>`). `ClaudeCodeAgentRunner` instead requires this to be a *bare binary name/path* (e.g. `"claude"`) — the spec's own default value contains a space and is rejected outright by that runner (`codex_not_found`). |
| `approval_policy` | string \| null | `null` | Pass-through, implementation-defined. Unused by either shipped runner today (`ClaudeCodeAgentRunner` hardcodes its own permission-mode logic instead — see `docs/agent-runner-protocol.md`). |
| `thread_sandbox` | string \| null | `null` | Same: accepted, not acted on by either shipped runner. |
| `turn_sandbox_policy` | string \| null | `null` | Same. |
| `turn_timeout_ms` | positive integer | `3600000` (1 hr) | Per-turn **silence** timeout — resets on every output line/event from the agent, so it's not a hard cap on total turn duration. |
| `read_timeout_ms` | positive integer | `5000` | Used by `SubprocessAgentRunner`'s session-startup handshake. Not used by `ClaudeCodeAgentRunner`, which has no separate handshake phase. |
| `stall_timeout_ms` | integer | `300000` (5 min) | Enforced by the **orchestrator**, not the runner: kills and retries a run with no agent events for this long. `<= 0` disables stall detection. |

### `agent_runner` (CLI-only extension, not in SPEC.md)

| Key | Type | Default | Notes |
| --- | ---- | ------- | ----- |
| `kind` | `"subprocess"` \| `"claude_code"` | `"subprocess"` | Selects the `AgentRunner` implementation (`src/agent/registry.ts`). Any other value silently falls back to `"subprocess"`. See `docs/agent-runner-protocol.md` for what each one actually does — the default is a reference/test harness, not a real coding agent. |

## Prompt template (the Markdown body)

Rendered per issue with [LiquidJS](https://liquidjs.com/) in **strict mode**: an unknown variable
or filter fails the render (`template_render_error`) rather than silently emitting nothing. A
malformed template fails to parse (`template_parse_error`). Both are per-attempt failures — they
don't block dispatch of other issues the way a workflow load error does.

If the template body is empty (no front matter and no text, or an empty body after front matter),
a minimal fallback is used: `"You are working on an issue from the configured tracker."`

Available variables:

- `attempt` — integer or `null`. `null` on the first-ever run; an integer on retry/continuation.
- `issue` — the normalized issue, in **snake_case** (`src/prompt/render.ts:
  issueToTemplateContext`):

  | Field | Type |
  | ----- | ---- |
  | `issue.id` | string |
  | `issue.native_ref` | object or null (adapter-specific, non-secret) |
  | `issue.identifier` | string (e.g. `ENG-123`) |
  | `issue.title` | string |
  | `issue.description` | string or null |
  | `issue.priority` | integer (1–4, lower = higher priority) or null |
  | `issue.state` | string |
  | `issue.branch_name` | string or null |
  | `issue.url` | string or null |
  | `issue.assignee_id` | string or null |
  | `issue.labels` | string[] (lowercased) |
  | `issue.blocked_by` | array of `{id, identifier, state}` |
  | `issue.dispatchable` | boolean |
  | `issue.created_at` / `issue.updated_at` | ISO 8601 string or null |

This is the **first-turn** prompt only. Later turns within the same worker run (up to
`agent.max_turns`) get fixed continuation guidance instead of a re-render of this template — see
`buildContinuationGuidance` in `src/prompt/render.ts` — so don't rely on per-turn template logic
for anything past turn 1.

## Field name convention

Front matter uses `snake_case` throughout (`active_states`, `max_concurrent_agents`, ...), matching
SPEC.md. This is unrelated to the internal TypeScript config's `camelCase` field names
(`ServiceConfig.tracker.activeStates`, etc.) — `src/config/resolve.ts` does the translation: it's a
convention to know when reading source, not something `WORKFLOW.md` authors need to think about.
