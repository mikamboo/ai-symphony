# Linear tracker adapter profile

Per SPEC.md Section 11.2, every tracker adapter must publish a compact profile documenting its
configuration, scope, normalization, and error behavior. This is that profile for
`src/tracker/linear.ts`.

## `tracker.kind`

```yaml
tracker:
  kind: linear
```

## `tracker.provider` keys

| Key          | Type    | Required | Default                          | Notes                                                                 |
| ------------ | ------- | -------- | --------------------------------- | ---------------------------------------------------------------------- |
| `api_key`    | string  | yes (secret) | -                              | Linear personal API key or OAuth access token. Supports `$VAR_NAME` indirection (SPEC.md 5.3.1/6.1). Falls back to the `LINEAR_API_KEY` environment variable when omitted. An empty resolved value is treated as missing. |
| `team_id`    | string  | no       | none (all teams visible to the key) | Linear team UUID to scope issues to.                                   |
| `team_key`   | string  | no       | none                              | Linear team key (e.g. `ENG`); used only if `team_id` is not set.        |
| `project_id` | string  | no       | none                              | Linear project UUID to further scope issues.                           |
| `page_size`  | integer | no       | `100`                             | GraphQL page size for `fetch_issues_by_states` pagination.             |
| `endpoint`   | string  | no       | `https://api.linear.app/graphql`  | Override for testing against a mock GraphQL server.                    |

Example:

```yaml
tracker:
  kind: linear
  provider:
    api_key: $LINEAR_API_KEY
    team_key: ENG
  required_labels: [symphony]
  active_states: [Todo, "In Progress"]
  terminal_states: [Done, Canceled, Duplicate]
```

## Secrets

`secret_environment_names()` returns `["LINEAR_API_KEY"]`. The CLI wiring
(`src/cli.ts`) passes this list to `SubprocessAgentRunner`, which strips those variable names from
the coding-agent child process environment (SPEC.md 15.3). This adapter never places the resolved
API key in the coding-agent's `cwd` or environment; it is only used host-side for GraphQL requests.

## `id` / `native_ref` mapping

- `id`: the Linear issue's internal UUID (`issue.id`). Stable and opaque; never assumed to be the
  provider's underlying ticket ID by orchestrator core logic.
- `native_ref`: `{ team_id, team_key, url }` — all non-secret, JSON-safe.

## Scope selection and pagination

- Scope is `team_id` (or `team_key`) and, if set, `project_id`, applied as a GraphQL `filter` on
  the `issues` query.
- `fetch_issues_by_states` fetches the full configured scope with cursor-based pagination
  (`pageInfo.hasNextPage` / `endCursor`, page size `page_size`) up to 50 pages, then filters
  client-side by state name (case-insensitively) rather than pushing state filtering into the
  GraphQL query, to keep the case-insensitive matching contract exact.
- `fetch_issues_by_ids` issues a single `issues(filter: { id: { in: $ids } })` query.
- Both empty-input cases (`[]`) short-circuit to `ok([])` without a GraphQL request.

## Field normalization

- `title`, `identifier`, `state.name`, `id` are required; a node missing any of them is treated as
  malformed (dropped + logged for state-list reads, fails the whole call for ID-refresh reads, per
  SPEC.md 11.1).
- `priority`: Linear's own priority scale (`0` = no priority, `1` = urgent ... `4` = low) already
  matches SPEC.md's "lower number = higher priority" convention. `0` normalizes to `null`.
- `labels`: lowercased, trimmed, deduplicated.
- `blocked_by`: best-effort, derived from `inverseRelations(filter: { type: { eq: "blocks" } })` —
  i.e. issues that block *this* issue. Not a complete blocker graph; only directly attached
  relations of type `blocks`.
- `dispatchable`: always `true` for issues returned within the configured team/project scope. This
  adapter does not implement assignment- or board-based routing beyond scope selection; narrow
  eligibility with `tracker.required_labels` and/or `tracker.active_states` instead.
- `created_at` / `updated_at`: passed through from Linear's ISO 8601 timestamps (RFC 3339
  compatible).

## Provider-native agent tools

Not shipped in this core-conformance pass. This adapter is read-only: it never writes to Linear.
Ticket mutations (state transitions, comments) are expected to be handled by the coding agent
through whatever tools it is separately given, outside Symphony's core scheduler (SPEC.md 11.5).

## Error mapping

| Condition                                   | Category              | `retryable` |
| -------------------------------------------- | ---------------------- | ------------ |
| Network/transport failure                    | `tracker_request`      | `true`       |
| HTTP 429                                     | `tracker_rate_limited` | `true` (honors `Retry-After` when present) |
| HTTP non-2xx (other)                         | `tracker_status`       | `true` if `>= 500`, else `false` |
| Invalid JSON body                            | `tracker_response`     | `false`      |
| GraphQL `errors` array present               | `tracker_response`     | `false`      |
| Missing `data` in response                   | `tracker_response`     | `false`      |
| Pagination exceeds 50 pages                  | `tracker_pagination`   | `false`      |
| Missing/empty `api_key`                      | `missing_tracker_secret` | `false`    |

## Real integration profile (SPEC.md 17.8)

To run a smoke test against a real Linear workspace, set `LINEAR_API_KEY` (or `tracker.provider.api_key`)
to a personal API key scoped to a disposable test team, and point `team_key`/`team_id` at that team.
This adapter has no automated Real Integration Profile test in this repository yet; see
`src/tracker/linear.ts` for the GraphQL queries it issues if you want to write one.
