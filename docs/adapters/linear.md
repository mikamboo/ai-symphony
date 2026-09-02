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
- `blocked_by`: best-effort, derived from `inverseRelations` (Linear's `Issue.inverseRelations`
  connection field does not accept a server-side `filter` argument, so all relation types are
  fetched and narrowed client-side to `type === "blocks"` — i.e. issues that block *this* issue).
  Not a complete blocker graph; only directly attached relations of type `blocks`, and only the
  first page returned by the connection (no pagination is applied here).
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

**Schema validation** (`src/tracker/linear.schema.test.ts`, opt-in, no API key needed): sends the
adapter's exact GraphQL queries to the real `api.linear.app/graphql` endpoint with a deliberately
invalid token and asserts the response is a plain auth error rather than
`GRAPHQL_VALIDATION_FAILED`. GraphQL schema validation happens before auth is checked, so this
catches query/field/argument typos against Linear's actual schema without needing real
credentials — run it with:

```bash
SYMPHONY_TEST_LIVE_LINEAR_SCHEMA=1 pnpm vitest run src/tracker/linear.schema.test.ts
```

This exists because `Issue.inverseRelations(filter: ...)` shipped with an argument that doesn't
exist on Linear's real schema (it was written from memory, never checked against the live API) and
caused every request — both `fetch_issues_by_states` and `fetch_issues_by_ids` — to fail with
`HTTP 400`. Fixed by dropping the invalid `filter` argument; the client already narrows
`inverseRelations` to `type === "blocks"` itself. If you add or change a query field, run this
test (or introspect manually — `{ __type(name: "TypeName") { inputFields { name } } }` against the
same endpoint, no auth required) before assuming it's correct.

There is no automated **behavioral** Real Integration Profile test (one that dispatches a real
issue end-to-end) in this repository yet; see `src/tracker/linear.ts` if you want to write one.
