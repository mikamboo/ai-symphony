# GitHub Projects tracker adapter profile

Source: `src/tracker/github.ts`. Tests: `src/tracker/github.test.ts` (unit) and
`src/tracker/github.live.test.ts` (opt-in, real API). Read-only. It never writes to GitHub.

The adapter targets **GitHub Projects (v2)**, the current board product, through the GraphQL API.
It does not support classic Projects, which GitHub has shut down, or plain repo issues without a
Project.

## `tracker.kind`

`github`

## `tracker.provider` keys

| Key | Type | Default | Notes |
| --- | ---- | ------- | ----- |
| `token` | string (secret) | `$GITHUB_TOKEN` | See [Token choice](#token-choice). Supports `$VAR` indirection. If it resolves to an empty value, preflight treats it as missing. |
| `owner` | string | **required** | Login of the org or user that owns the Project. Both work without a switch: the query uses `repositoryOwner { ... on ProjectV2Owner }`. |
| `project_number` | positive integer | **required** | The `N` in `github.com/orgs/<owner>/projects/N` or `github.com/users/<owner>/projects/N`. |
| `status_field` | string | `"Status"` | Name of the **single-select** Project field whose value is the issue's state. Checked on every listing: a missing field or a field of another type fails with `invalid_tracker_config`. Each configured state that isn't one of the field's options is logged once as `tracker.unknown_state`. |
| `server_filter` | boolean | `true` | Narrow listings on GitHub's side with the Projects filter query. Set it to `false` to list every item and filter locally. That is the escape hatch if GitHub's filter syntax ever disagrees with the local match (see [Scope selection](#scope-selection-and-pagination)). |
| `page_size` | integer | `100` | Clamped to 100, GitHub's maximum. |
| `endpoint` | string | `https://api.github.com/graphql` | Override for tests or GitHub Enterprise Server (`https://<host>/api/graphql`). |

`active_states` and `terminal_states` hold **Status option names** (e.g. `Todo`, `In Progress`,
`Done`), compared case-insensitively. They are not the issue's open/closed state. Open/closed is
handled separately: a **closed issue is never dispatched**, whatever its Status, and a running
worker stops on the next reconciliation refresh after its issue closes. Its workspace is kept
unless the item also reaches a `terminal_states` Status. To have closed issues' workspaces cleaned
up, enable the Project's built-in "Item closed → set Status: Done" workflow and list `Done` in
`terminal_states`.

### Token choice

The adapter only reads. It needs read access to the Project, plus read access to issues in every
repo the board pulls items from.

| Project owner | Token | Grants |
| ------------- | ----- | ------ |
| Organization | **Fine-grained PAT (recommended)**, resource owner = the org | Organization → Projects: read. Repository → Issues: read, on the repos the board pulls from. Read-only, scoped. |
| User account | **Classic PAT** (required) | `read:project`, plus `repo` if any of the board's repos is private, or `public_repo` otherwise. |

Fine-grained PATs **cannot access user-owned Projects**. GitHub lists this as a current limitation
of fine-grained tokens. Classic tokens have no read-only scope for private repos, so `repo` grants
**write** access to every repo the account can reach. That is far more than this adapter needs.
For user-owned boards with private repos, use a dedicated machine account with access to only those
repos, or move the board to an organization.

## Secrets

`secretEnvironmentNames()` returns `GITHUB_TOKEN` and `GH_TOKEN`. Both are stripped from the
coding-agent child environment (SPEC.md 15.3). If the agent needs to push or open PRs, give it a
separate, narrower credential through the workspace hooks, e.g. a deploy key or a fine-grained token
with contents write on one repo. Don't reuse the tracker token.

## `id` / `native_ref` mapping

- `id`: the **Project item** node ID (`PVTI_…`), not the issue ID. The Status lives on the item,
  and refreshes by ID must return the item's current Status.
- `identifier`: `owner/repo#number`. The workspace key sanitizes `/` and `#` and adds a hash
  suffix (`src/workspace/key.ts`).
- `native_ref`: `{ issue_id, repository, number, url }`, all non-secret.

Consequences of using the item as the ID. Both are accepted trade-offs:

- **Removing an issue from the board and re-adding it** creates a new item ID. Symphony sees a new
  issue: a fresh claim and retry count, but the same workspace, because the workspace key comes
  from `owner/repo#N`.
- **Transferring an issue to another repo** changes its identifier, so a new workspace is created.
  The old one is not cleaned up automatically.

## Scope selection and pagination

An item is in scope only if it is a **non-archived `Issue` item with a Status value**. Draft
issues, pull requests, archived items, items whose content the token can't see, and items with no
Status are treated as invisible, not malformed.

- `fetchIssuesByStates(states)` sends the Projects filter query
  `is:issue <status_field>:<v1>,"<v 2>"` through `items(query:)` and pages through the results
  (cursor pagination, 50-page cap of 5,000 items per call).
  - The Status match is **always repeated locally**. The server filter only reduces how much is
    downloaded, so if it is too broad nothing is dispatched wrongly. If it is too narrow, work is
    silently missed; that is what `github.live.test.ts` checks.
  - GitHub documents quoting for filter *values* with spaces (`status:"In progress"`) and comma
    lists as OR (`label:bug,support`). It does not document a syntax for field *names* with
    spaces. So when `status_field` contains anything outside `[A-Za-z0-9_-]`, or a state name
    contains `"`, the adapter sends `is:issue` alone and matches Status locally.
  - Archived items are excluded by GitHub's default (`archivedStates: [NOT_ARCHIVED]`).
- `fetchIssuesByIds` uses `nodes(ids:)` in chunks of 100. An item is omitted, not invented, if it
  was deleted, archived, moved to another Project, is no longer an Issue, or had its Status
  cleared. These are normal board actions: omitting the item makes reconciliation stop its worker,
  where failing would error every tick. Any other malformed requested record fails the whole call,
  as SPEC.md requires.

Cost: each page is a few GraphQL rate-limit points (100 items with up to 50 labels and 50 blockers
each). A normal tick is one or two pages thanks to the filter. The startup listing of
`terminal_states` is the largest scan, and it is filtered too.

## Field normalization

| `Issue` field | Source |
| ------------- | ------ |
| `title` / `description` | `Issue.title` / `Issue.body` |
| `state` | Status field value (trimmed) |
| `priority` | `null` (GitHub has no native priority; a custom Priority field is not read) |
| `branchName` | `null` |
| `assigneeId` | First assignee's node ID |
| `labels` | Trimmed, lowercased, deduplicated (first 50) |
| `blockedBy` | Native issue dependencies, `Issue.blockedBy(first: 50)`. `identifier` is `owner/repo#n`. `state` is the blocker's **issue** state lowercased (`open`/`closed`), not its Project Status, because the blocker may live in another Project or none. Exposed to the prompt template only; the orchestrator doesn't gate on blockers. |
| `dispatchable` | `true` only while the issue is `OPEN` |

## Error mapping

Transport and error mapping are shared with the Linear adapter (`src/tracker/graphql.ts`).

| Condition | Category | Retryable |
| --------- | -------- | --------- |
| Network failure | `tracker_request` | yes |
| HTTP 429; HTTP 403 with `retry-after` (secondary limit) or `x-ratelimit-remaining: 0` (primary); GraphQL `RATE_LIMITED` | `tracker_rate_limited` | yes (honors `retry-after`) |
| Other non-2xx (including a plain 403 permission error) | `tracker_status` | 5xx only |
| GraphQL `errors`, missing `data`, invalid JSON, Project not found/visible | `tracker_response` | no |
| More than 50 pages | `tracker_pagination` | no |
| Missing/invalid `owner`, `project_number` or `server_filter`; `status_field` missing or not single-select | `invalid_tracker_config` | no |
| Missing token | `missing_tracker_secret` | n/a |

## Real integration profile (SPEC.md 17.8)

**Status: schema-validated, live test written but not yet run.**

- Both GraphQL documents were validated with `graphql-js` against GitHub's current public schema
  (`https://docs.github.com/public/fpt/schema.docs.graphql`, fetched 2026-10-03). Use that file,
  not `@octokit/graphql-schema`: version 15.26.1 of the package predates issue dependencies and
  wrongly reports `Issue.blockedBy` as unknown.
- GitHub authenticates before it validates a query, so the credential-free probe used by
  `linear.schema.test.ts` doesn't work here. `github.live.test.ts` needs a real token and Project:

  ```sh
  SYMPHONY_TEST_LIVE_GITHUB=1 GITHUB_TOKEN=... \
  SYMPHONY_TEST_GITHUB_OWNER=<org-or-user> SYMPHONY_TEST_GITHUB_PROJECT_NUMBER=<n> \
  pnpm vitest run src/tracker/github.live.test.ts
  ```

  For each Status option, and for all of them together, it checks that the server-filtered listing
  returns exactly the same items as the unfiltered, locally matched one. It also checks that
  refreshing listed items by ID returns the same states. Run it against a board with an option whose
  name contains a space, before relying on `server_filter: true` in production.
- Not yet verified live: the filter syntax above, and `repositoryOwner { ... on ProjectV2Owner }`
  resolution for both org-owned and user-owned Projects.
