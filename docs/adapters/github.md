# GitHub Projects tracker adapter profile

Source: `src/tracker/github.ts`. Tests: `src/tracker/github.test.ts`. Read-only. It never writes
to GitHub.

The adapter targets **GitHub Projects (v2)**, the current board product, through the GraphQL API.
It does not support classic Projects, which GitHub has shut down, or plain repo issues without a
Project.

## `tracker.kind`

`github`

## `tracker.provider` keys

| Key | Type | Default | Notes |
| --- | ---- | ------- | ----- |
| `token` | string (secret) | `$GITHUB_TOKEN` | A PAT, either classic (`read:project` + `repo`) or fine-grained (Projects: read, Issues: read, on the repos the board pulls from). Supports `$VAR` indirection. If it resolves to an empty value, preflight treats it as missing. |
| `owner` | string | **required** | Login of the org or user that owns the Project. Both work without a switch: the query uses `repositoryOwner { ... on ProjectV2Owner }`. |
| `project_number` | positive integer | **required** | The `N` in `github.com/orgs/<owner>/projects/N` or `github.com/users/<owner>/projects/N`. |
| `status_field` | string | `"Status"` | Name of the **single-select** Project field whose value is the issue's state. |
| `page_size` | integer | `100` | Clamped to 100, GitHub's maximum. |
| `endpoint` | string | `https://api.github.com/graphql` | Override for tests or GitHub Enterprise Server (`https://<host>/api/graphql`). |

`active_states` and `terminal_states` hold **Status option names** (e.g. `Todo`, `In Progress`,
`Done`), compared case-insensitively. They are not the issue's open/closed state. Closing an
issue does not change its Status unless the Project's built-in "Item closed → Done" workflow is
enabled. Keep that workflow on, or list the closed-state Status in `terminal_states`.

## Secrets

`secretEnvironmentNames()` returns `GITHUB_TOKEN` and `GH_TOKEN`. Both are stripped from the
coding-agent child environment (SPEC.md 15.3). If the agent needs to push or open PRs, give it
its own credential through the workspace hooks. Don't reuse the tracker token.

## `id` / `native_ref` mapping

- `id`: the **Project item** node ID (`PVTI_…`), not the issue ID. The Status lives on the item,
  and refreshes by ID must return the item's current Status.
- `identifier`: `owner/repo#number`. The workspace key sanitizes `/` and `#` and adds a hash
  suffix (`src/workspace/key.ts`).
- `native_ref`: `{ issue_id, repository, number, url }`, all non-secret.

## Scope selection and pagination

- `fetchIssuesByStates` lists every item in the Project (cursor pagination, 50-page cap), then
  filters on the Status value on the client side. GitHub's `items` connection has no server-side
  field-value filter.
- Only `Issue` items are returned. Draft issues, pull requests, items whose content the token
  can't see, and items with no Status are skipped. They are out of scope by design and aren't
  logged as malformed.
- `fetchIssuesByIds` uses `nodes(ids:)` in chunks of 100. An item is omitted, not invented, if it
  was deleted, moved to another Project, is no longer an Issue, or had its Status cleared.
  Clearing a Status is a normal board action, so it must not fail every reconciliation tick.
  Any other malformed requested record fails the whole call, as SPEC.md requires.

## Field normalization

| `Issue` field | Source |
| ------------- | ------ |
| `title` / `description` | `Issue.title` / `Issue.body` |
| `state` | Status field value (trimmed) |
| `priority` | `null` (GitHub has no native priority; a custom Priority field is not read) |
| `branchName` | `null` |
| `assigneeId` | First assignee's node ID |
| `labels` | Trimmed, lowercased, deduplicated (first 50) |
| `blockedBy` | Native issue dependencies, `Issue.blockedBy(first: 50)`. `identifier` is `owner/repo#n`. `state` is the blocker's **issue** state lowercased (`open`/`closed`), not its Project Status, because the blocker may live in another Project or none. |
| `dispatchable` | Always `true` |

## Error mapping

| Condition | Category | Retryable |
| --------- | -------- | --------- |
| Network failure | `tracker_request` | yes |
| HTTP 429, HTTP 403 with `x-ratelimit-remaining: 0`, or GraphQL `RATE_LIMITED` | `tracker_rate_limited` | yes (honors `retry-after`) |
| Other non-2xx | `tracker_status` | 5xx only |
| GraphQL `errors`, missing `data`, invalid JSON, Project not found/visible | `tracker_response` | no |
| More than 50 pages | `tracker_pagination` | no |
| Missing/invalid `owner` or `project_number` | `invalid_tracker_config` | n/a |
| Missing token | `missing_tracker_secret` | n/a |

## Real integration profile (SPEC.md 17.8)

**Status: schema-validated, not yet run against a live Project.**

- Both GraphQL documents (`GITHUB_PROJECT_ITEMS_QUERY`, `GITHUB_ITEMS_BY_IDS_QUERY`) were
  validated with `graphql-js` against GitHub's current public schema
  (`https://docs.github.com/public/fpt/schema.docs.graphql`, fetched 2026-10-03). Unlike Linear,
  GitHub authenticates before it validates the query, so a no-credential probe like
  `linear.schema.test.ts` doesn't work here.
- Use GitHub's own schema file, not `@octokit/graphql-schema`. Version 15.26.1 of that package
  predates issue dependencies and wrongly reports `Issue.blockedBy` as unknown.
- Not yet verified: a live run with a real token against a real board, including the
  `repositoryOwner { ... on ProjectV2Owner }` resolution for both org-owned and user-owned
  Projects.
