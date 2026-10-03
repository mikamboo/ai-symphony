import { err, ok, TrackerError, type Result } from "../domain/errors.js";
import type { BlockerRef, Issue, ServiceConfig } from "../domain/types.js";
import type { Logger } from "../logging/logger.js";
import { resolveVarIndirection } from "../config/resolve.js";
import type { TrackerAdapter } from "./adapter.js";

/**
 * GitHub Projects (v2) tracker adapter profile (SPEC.md 11.2 compact profile; see also
 * docs/adapters/github.md).
 *
 * `tracker.kind`: `"github"`
 *
 * `tracker.provider` keys:
 * - `token` (string, secret): GitHub PAT / app token with `read:project` and repo read access.
 *   Supports `$VAR_NAME` indirection. Falls back to `GITHUB_TOKEN` when omitted. Empty resolution
 *   is treated as missing (SPEC.md 5.3.1).
 * - `owner` (string, required): login of the organization or user that owns the Project.
 * - `project_number` (integer, required): the number in the Project URL
 *   (`github.com/orgs/<owner>/projects/<number>`).
 * - `status_field` (string, default `"Status"`): name of the single-select Project field whose
 *   value is the issue state matched against `active_states` / `terminal_states`.
 * - `page_size` (integer, default 100, max 100): GraphQL page size.
 * - `endpoint` (string, default `"https://api.github.com/graphql"`): override for testing / GHES.
 *
 * `id` / `native_ref` mapping: `id` is the **Project item** node ID (the item carries the Status
 * value, and is what `fetchIssuesByIds` refreshes); `identifier` is `owner/repo#number`;
 * `native_ref` carries `{ issue_id, repository, number, url }`, all non-secret.
 *
 * Only `Issue` items are returned. Draft issues, pull requests, and items without a Status value
 * are not dispatchable work and are skipped.
 *
 * `blockedBy`: GitHub's native issue "blocked by" dependencies (exposed to the prompt template as
 * `issue.blocked_by`). `state` is the blocker's *issue* state lowercased (`open`/`closed`), not its
 * Project Status: the blocker may live in another project, or none.
 *
 * `dispatchable`: `true` for every returned item. Read-only; never writes to GitHub.
 */

const DEFAULT_ENDPOINT = "https://api.github.com/graphql";
const MAX_PAGES = 50;
const MAX_PAGE_SIZE = 100;

interface GitHubProviderConfig {
  token: string;
  owner: string;
  projectNumber: number;
  statusField: string;
  pageSize: number;
  endpoint: string;
}

function resolveSecret(raw: unknown, envFallback: string): string | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return resolveVarIndirection(raw);
  }
  const fromEnv = process.env[envFallback];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

function parseProviderConfig(provider: Record<string, unknown>): Result<GitHubProviderConfig, TrackerError> {
  const token = resolveSecret(provider.token, "GITHUB_TOKEN");
  if (!token) {
    return err(new TrackerError("missing_tracker_secret", "tracker.provider.token (or $GITHUB_TOKEN) is required and must be non-empty"));
  }

  const owner = typeof provider.owner === "string" ? provider.owner.trim() : "";
  if (!owner) {
    return err(new TrackerError("invalid_tracker_config", "tracker.provider.owner is required (organization or user login)"));
  }

  const projectNumber = provider.project_number;
  if (typeof projectNumber !== "number" || !Number.isInteger(projectNumber) || projectNumber <= 0) {
    return err(new TrackerError("invalid_tracker_config", "tracker.provider.project_number is required and must be a positive integer"));
  }

  const statusField =
    typeof provider.status_field === "string" && provider.status_field.trim().length > 0 ? provider.status_field.trim() : "Status";
  const pageSize =
    typeof provider.page_size === "number" && provider.page_size > 0 ? Math.min(Math.floor(provider.page_size), MAX_PAGE_SIZE) : MAX_PAGE_SIZE;
  const endpoint = typeof provider.endpoint === "string" && provider.endpoint.length > 0 ? provider.endpoint : DEFAULT_ENDPOINT;

  return ok({ token, owner, projectNumber, statusField, pageSize, endpoint });
}

interface GitHubIssueContent {
  __typename: "Issue";
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string | null;
  state: string;
  createdAt: string | null;
  updatedAt: string | null;
  repository: { nameWithOwner: string };
  labels: { nodes: { name: string }[] } | null;
  assignees: { nodes: { id: string }[] } | null;
  blockedBy: { nodes: { id: string; number: number; state: string; repository: { nameWithOwner: string } }[] } | null;
}

interface GitHubItemNode {
  id: string;
  fieldValueByName: { name?: string | null } | null;
  content: ({ __typename: string } & Partial<GitHubIssueContent>) | null;
}

const ITEM_FIELDS = `
  id
  fieldValueByName(name: $statusField) {
    ... on ProjectV2ItemFieldSingleSelectValue { name }
  }
  content {
    __typename
    ... on Issue {
      id
      number
      title
      body
      url
      state
      createdAt
      updatedAt
      repository { nameWithOwner }
      labels(first: 50) { nodes { name } }
      assignees(first: 1) { nodes { id } }
      blockedBy(first: 50) { nodes { id number state repository { nameWithOwner } } }
    }
  }
`;

/**
 * Exported for testing: the exact GraphQL documents sent to GitHub. `repositoryOwner` +
 * `... on ProjectV2Owner` resolves an organization or a user without a config switch.
 */
export const GITHUB_PROJECT_ITEMS_QUERY = `
  query ProjectItems($owner: String!, $number: Int!, $statusField: String!, $first: Int!, $after: String) {
    repositoryOwner(login: $owner) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          items(first: $first, after: $after) {
            nodes { ${ITEM_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
`;

export const GITHUB_ITEMS_BY_IDS_QUERY = `
  query ItemsByIds($ids: [ID!]!, $statusField: String!) {
    nodes(ids: $ids) {
      ... on ProjectV2Item {
        project { number owner { ... on Organization { login } ... on User { login } } }
        ${ITEM_FIELDS}
      }
    }
  }
`;

type ItemWithProject = GitHubItemNode & {
  project?: { number: number; owner: { login?: string } | null } | null;
};

function normalizeItem(node: GitHubItemNode): Issue | null {
  const content = node.content;
  if (!content || content.__typename !== "Issue") return null;

  const statusName = node.fieldValueByName?.name?.trim();
  if (!node.id || !statusName) return null;
  if (!content.id || typeof content.number !== "number" || !content.title || !content.repository?.nameWithOwner) return null;

  const repository = content.repository.nameWithOwner;
  const labels = (content.labels?.nodes ?? []).map((l) => l.name.trim().toLowerCase()).filter((l) => l.length > 0);

  const blockedBy: BlockerRef[] = (content.blockedBy?.nodes ?? []).map((b) => ({
    id: b.id,
    identifier: `${b.repository.nameWithOwner}#${b.number}`,
    state: b.state.toLowerCase()
  }));

  return {
    id: node.id,
    nativeRef: { issue_id: content.id, repository, number: content.number, url: content.url ?? null },
    identifier: `${repository}#${content.number}`,
    title: content.title,
    description: content.body ?? null,
    priority: null,
    state: statusName,
    branchName: null,
    url: content.url ?? null,
    assigneeId: content.assignees?.nodes[0]?.id ?? null,
    labels: Array.from(new Set(labels)),
    blockedBy,
    dispatchable: true,
    createdAt: content.createdAt ?? null,
    updatedAt: content.updatedAt ?? null
  };
}

export class GitHubTrackerAdapter implements TrackerAdapter {
  readonly kind = "github";
  private readonly providerConfig: GitHubProviderConfig;

  private constructor(
    providerConfig: GitHubProviderConfig,
    private readonly logger: Logger
  ) {
    this.providerConfig = providerConfig;
  }

  static create(config: ServiceConfig, logger: Logger): Result<GitHubTrackerAdapter, TrackerError> {
    const parsed = parseProviderConfig(config.tracker.provider);
    if (!parsed.ok) return parsed;
    return ok(new GitHubTrackerAdapter(parsed.value, logger));
  }

  secretEnvironmentNames(): string[] {
    return ["GITHUB_TOKEN", "GH_TOKEN"];
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<Result<T, TrackerError>> {
    let response: Response;
    try {
      response = await fetch(this.providerConfig.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.providerConfig.token}`,
          "User-Agent": "symphony"
        },
        body: JSON.stringify({ query, variables })
      });
    } catch (cause) {
      return err(new TrackerError("tracker_request", `GitHub request failed: ${String(cause)}`, { cause, retryable: true }));
    }

    const retryAfter = Number(response.headers.get("retry-after"));
    const rateLimited =
      response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
    if (rateLimited) {
      return err(
        new TrackerError("tracker_rate_limited", "GitHub API rate limit exceeded", {
          retryable: true,
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
        })
      );
    }

    if (!response.ok) {
      return err(new TrackerError("tracker_status", `GitHub API returned HTTP ${response.status}`, { retryable: response.status >= 500 }));
    }

    let body: { data?: T | null; errors?: { message: string; type?: string }[] };
    try {
      body = (await response.json()) as typeof body;
    } catch (cause) {
      return err(new TrackerError("tracker_response", "GitHub API returned invalid JSON", { cause }));
    }

    if (body.errors && body.errors.length > 0) {
      const rateLimitedGraphql = body.errors.some((e) => e.type === "RATE_LIMITED");
      return err(
        new TrackerError(
          rateLimitedGraphql ? "tracker_rate_limited" : "tracker_response",
          `GitHub API error: ${body.errors.map((e) => e.message).join("; ")}`,
          { retryable: rateLimitedGraphql }
        )
      );
    }
    if (body.data === undefined || body.data === null) {
      return err(new TrackerError("tracker_response", "GitHub API response missing 'data'"));
    }

    return ok(body.data);
  }

  private async fetchAllItems(): Promise<Result<GitHubItemNode[], TrackerError>> {
    const { owner, projectNumber, statusField, pageSize } = this.providerConfig;
    const all: GitHubItemNode[] = [];
    let after: string | undefined;

    type Page = {
      repositoryOwner: {
        projectV2?: { items: { nodes: (GitHubItemNode | null)[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null;
      } | null;
    };

    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.graphql<Page>(GITHUB_PROJECT_ITEMS_QUERY, {
        owner,
        number: projectNumber,
        statusField,
        first: pageSize,
        after
      });
      if (!result.ok) return result;

      const project = result.value.repositoryOwner?.projectV2;
      if (!project) {
        return err(
          new TrackerError(
            "tracker_response",
            `GitHub Project ${owner}#${projectNumber} not found or not visible to this token (needs read:project)`
          )
        );
      }

      all.push(...project.items.nodes.filter((n): n is GitHubItemNode => n !== null));
      const { hasNextPage, endCursor } = project.items.pageInfo;
      if (!hasNextPage || !endCursor) return ok(all);
      after = endCursor;
    }

    return err(new TrackerError("tracker_pagination", `Exceeded max pagination depth (${MAX_PAGES} pages) while listing GitHub Project items`));
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Result<Issue[], TrackerError>> {
    if (stateNames.length === 0) return ok([]);

    const items = await this.fetchAllItems();
    if (!items.ok) return items;

    const wanted = new Set(stateNames.map((s) => s.trim().toLowerCase()));
    const issues: Issue[] = [];
    for (const node of items.value) {
      // Drafts, PRs, and inaccessible content are out of scope by design, not malformed.
      if (node.content?.__typename !== "Issue") continue;
      const status = node.fieldValueByName?.name?.trim().toLowerCase();
      if (!status || !wanted.has(status)) continue;

      const normalized = normalizeItem(node);
      if (!normalized) {
        this.logger.warn("tracker.malformed_record_skipped", { native_id: node.id ?? "unknown" });
        continue;
      }
      issues.push(normalized);
    }
    return ok(issues);
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Result<Issue[], TrackerError>> {
    if (issueIds.length === 0) return ok([]);

    const issues: Issue[] = [];
    // GitHub caps `nodes(ids:)` at 100 per request.
    for (let i = 0; i < issueIds.length; i += MAX_PAGE_SIZE) {
      const chunk = issueIds.slice(i, i + MAX_PAGE_SIZE);
      const result = await this.graphql<{ nodes: (ItemWithProject | null)[] }>(GITHUB_ITEMS_BY_IDS_QUERY, {
        ids: chunk,
        statusField: this.providerConfig.statusField
      });
      if (!result.ok) return result;

      for (const node of result.value.nodes) {
        // Deleted/inaccessible items resolve to null (or an empty object for non-item IDs): omit.
        if (!node || !node.id) continue;
        // Only items still in the configured project are "in scope".
        if (
          node.project?.number !== this.providerConfig.projectNumber ||
          node.project.owner?.login?.toLowerCase() !== this.providerConfig.owner.toLowerCase()
        ) {
          continue;
        }
        // Drafts and PRs were never dispatchable; treat as no longer visible.
        if (node.content?.__typename !== "Issue") continue;
        // A cleared Status is a legitimate board action, not a malformed record: the item has
        // no state, so it is no longer visible to any state-based scope.
        if (!node.fieldValueByName?.name?.trim()) continue;

        const normalized = normalizeItem(node);
        if (!normalized) {
          return err(new TrackerError("tracker_response", `GitHub returned a malformed record for requested item id ${node.id}`));
        }
        issues.push(normalized);
      }
    }
    return ok(issues);
  }
}
