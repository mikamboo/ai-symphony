import { err, ok, TrackerError, type Result } from "../domain/errors.js";
import type { BlockerRef, Issue, ServiceConfig } from "../domain/types.js";
import type { Logger } from "../logging/logger.js";
import type { TrackerAdapter } from "./adapter.js";
import { postGraphql, resolveSecret } from "./graphql.js";

/**
 * GitHub Projects (v2) tracker adapter profile (SPEC.md 11.2 compact profile; see also
 * docs/adapters/github.md).
 *
 * `tracker.kind`: `"github"`
 *
 * `tracker.provider` keys:
 * - `token` (string, secret): GitHub token with Projects read and issue read access. Supports
 *   `$VAR_NAME` indirection. Falls back to `GITHUB_TOKEN` when omitted. Empty resolution is
 *   treated as missing (SPEC.md 5.3.1).
 * - `owner` (string, required): login of the organization or user that owns the Project.
 * - `project_number` (integer, required): the number in the Project URL
 *   (`github.com/orgs/<owner>/projects/<number>`).
 * - `status_field` (string, default `"Status"`): name of the single-select Project field whose
 *   value is the issue state matched against `active_states` / `terminal_states`. Validated on
 *   every listing: a missing or non-single-select field fails with `invalid_tracker_config`.
 * - `server_filter` (boolean, default `true`): narrow listings server-side with the Projects
 *   filter query (`is:issue status:...`). Set `false` to list every item and filter locally.
 * - `page_size` (integer, default 100, max 100): GraphQL page size.
 * - `endpoint` (string, default `"https://api.github.com/graphql"`): override for testing / GHES.
 *
 * `id` / `native_ref` mapping: `id` is the **Project item** node ID (the item carries the Status
 * value, and is what `fetchIssuesByIds` refreshes); `identifier` is `owner/repo#number`;
 * `native_ref` carries `{ issue_id, repository, number, url }`, all non-secret.
 *
 * Scope: non-archived `Issue` items with a Status value. Draft issues, pull requests, archived
 * items, and items without a Status are not visible.
 *
 * `blockedBy`: GitHub's native issue "blocked by" dependencies (exposed to the prompt template as
 * `issue.blocked_by`). `state` is the blocker's *issue* state lowercased (`open`/`closed`), not its
 * Project Status: the blocker may live in another project, or none.
 *
 * `dispatchable`: `true` only while the issue is open. A closed issue in an active Status is never
 * dispatched, and a running one is stopped on its next reconciliation refresh.
 *
 * Read-only; never writes to GitHub.
 */

const DEFAULT_ENDPOINT = "https://api.github.com/graphql";
const MAX_PAGES = 50;
const MAX_PAGE_SIZE = 100;
const SINGLE_SELECT_FIELD = "ProjectV2SingleSelectField";
/** Field names the Projects filter syntax is documented to accept as a bare qualifier key. */
const SIMPLE_FIELD_NAME = /^[A-Za-z0-9_-]+$/;
const BARE_FILTER_VALUE = /^[A-Za-z0-9_-]+$/;

interface GitHubProviderConfig {
  token: string;
  owner: string;
  projectNumber: number;
  statusField: string;
  serverFilter: boolean;
  pageSize: number;
  endpoint: string;
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

  if (provider.server_filter !== undefined && typeof provider.server_filter !== "boolean") {
    return err(new TrackerError("invalid_tracker_config", "tracker.provider.server_filter must be a boolean"));
  }

  const statusField =
    typeof provider.status_field === "string" && provider.status_field.trim().length > 0 ? provider.status_field.trim() : "Status";
  const pageSize =
    typeof provider.page_size === "number" && provider.page_size > 0 ? Math.min(Math.floor(provider.page_size), MAX_PAGE_SIZE) : MAX_PAGE_SIZE;
  const endpoint = typeof provider.endpoint === "string" && provider.endpoint.length > 0 ? provider.endpoint : DEFAULT_ENDPOINT;

  return ok({ token, owner, projectNumber, statusField, serverFilter: provider.server_filter !== false, pageSize, endpoint });
}

/**
 * Build the Projects filter string for a state listing. Exported for testing.
 *
 * Always restricts to issues. Adds a `<field>:<v1>,<v2>` qualifier only when the syntax is
 * unambiguous: GitHub documents quoting for *values* with spaces but not for field *names*, so a
 * field name outside `[A-Za-z0-9_-]`, or a value containing a double quote, falls back to
 * `is:issue` alone and the Status match happens locally (which it always does anyway).
 */
export function buildItemsFilter(statusField: string, stateNames: string[], serverFilter: boolean): string {
  if (!serverFilter) return "";
  const values = stateNames.map((s) => s.trim()).filter((s) => s.length > 0);
  if (!SIMPLE_FIELD_NAME.test(statusField) || values.length === 0 || values.some((v) => v.includes('"'))) {
    return "is:issue";
  }
  const encoded = values.map((v) => (BARE_FILTER_VALUE.test(v) ? v : `"${v}"`)).join(",");
  return `is:issue ${statusField.toLowerCase()}:${encoded}`;
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
  isArchived?: boolean | null;
  fieldValueByName: { name?: string | null } | null;
  content: ({ __typename: string } & Partial<GitHubIssueContent>) | null;
}

type ItemWithProject = GitHubItemNode & {
  project?: { number: number; owner: { login?: string } | null } | null;
};

interface StatusFieldInfo {
  __typename: string;
  options?: { name: string }[];
}

const ITEM_FIELDS = `
  id
  isArchived
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
 * `... on ProjectV2Owner` resolves an organization or a user without a config switch. The status
 * field's configuration rides along on every page so a misconfigured `status_field` fails loudly.
 */
export const GITHUB_PROJECT_ITEMS_QUERY = `
  query ProjectItems($owner: String!, $number: Int!, $statusField: String!, $query: String!, $first: Int!, $after: String) {
    repositoryOwner(login: $owner) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          field(name: $statusField) {
            __typename
            ... on ProjectV2SingleSelectField { options { name } }
          }
          items(first: $first, after: $after, query: $query) {
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

function normalizeItem(node: GitHubItemNode): Issue | null {
  const content = node.content;
  if (!content || content.__typename !== "Issue") return null;

  const statusName = node.fieldValueByName?.name?.trim();
  if (!node.id || !statusName) return null;
  if (!content.id || typeof content.number !== "number" || !content.title || !content.repository?.nameWithOwner || !content.state) {
    return null;
  }

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
    dispatchable: content.state === "OPEN",
    createdAt: content.createdAt ?? null,
    updatedAt: content.updatedAt ?? null
  };
}

/** In scope: a non-archived Issue item with a Status value. Everything else is invisible, not malformed. */
function inScope(node: GitHubItemNode): boolean {
  return node.isArchived !== true && node.content?.__typename === "Issue" && Boolean(node.fieldValueByName?.name?.trim());
}

export class GitHubTrackerAdapter implements TrackerAdapter {
  readonly kind = "github";
  private readonly providerConfig: GitHubProviderConfig;
  /** Configured state names already reported as missing from the Status options (warn once each). */
  private readonly warnedUnknownStates = new Set<string>();

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

  private graphql<T>(query: string, variables: Record<string, unknown>): Promise<Result<T, TrackerError>> {
    return postGraphql<T>({
      provider: "GitHub",
      endpoint: this.providerConfig.endpoint,
      headers: { Authorization: `Bearer ${this.providerConfig.token}`, "User-Agent": "symphony" },
      query,
      variables
    });
  }

  /** Fail on a missing / non-single-select status field; warn once per state name it doesn't offer. */
  private checkStatusField(field: StatusFieldInfo | null | undefined, stateNames: string[]): Result<void, TrackerError> {
    const { statusField, owner, projectNumber } = this.providerConfig;
    if (!field) {
      return err(new TrackerError("invalid_tracker_config", `GitHub Project ${owner}#${projectNumber} has no field named '${statusField}' (tracker.provider.status_field)`));
    }
    if (field.__typename !== SINGLE_SELECT_FIELD) {
      return err(
        new TrackerError("invalid_tracker_config", `GitHub Project field '${statusField}' must be a single-select field, found ${field.__typename}`)
      );
    }

    const options = new Set((field.options ?? []).map((o) => o.name.trim().toLowerCase()));
    for (const state of stateNames) {
      const normalized = state.trim().toLowerCase();
      if (normalized.length === 0 || options.has(normalized) || this.warnedUnknownStates.has(normalized)) continue;
      this.warnedUnknownStates.add(normalized);
      this.logger.warn("tracker.unknown_state", {
        state,
        status_field: statusField,
        available: (field.options ?? []).map((o) => o.name).join(", ")
      });
    }
    return ok(undefined);
  }

  private async fetchItems(stateNames: string[]): Promise<Result<GitHubItemNode[], TrackerError>> {
    const { owner, projectNumber, statusField, pageSize, serverFilter } = this.providerConfig;
    const query = buildItemsFilter(statusField, stateNames, serverFilter);
    const all: GitHubItemNode[] = [];
    let after: string | undefined;

    type Page = {
      repositoryOwner: {
        projectV2?: {
          field: StatusFieldInfo | null;
          items: { nodes: (GitHubItemNode | null)[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        } | null;
      } | null;
    };

    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.graphql<Page>(GITHUB_PROJECT_ITEMS_QUERY, {
        owner,
        number: projectNumber,
        statusField,
        query,
        first: pageSize,
        after
      });
      if (!result.ok) return result;

      const project = result.value.repositoryOwner?.projectV2;
      if (!project) {
        return err(
          new TrackerError("tracker_response", `GitHub Project ${owner}#${projectNumber} not found or not visible to this token`)
        );
      }
      if (page === 0) {
        const fieldCheck = this.checkStatusField(project.field, stateNames);
        if (!fieldCheck.ok) return fieldCheck;
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

    const items = await this.fetchItems(stateNames);
    if (!items.ok) return items;

    // The server-side filter only narrows; the authoritative Status match is always local.
    const wanted = new Set(stateNames.map((s) => s.trim().toLowerCase()));
    const issues: Issue[] = [];
    for (const node of items.value) {
      if (!inScope(node)) continue;
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
        // Only items still in the configured project are in scope.
        if (
          node.project?.number !== this.providerConfig.projectNumber ||
          node.project.owner?.login?.toLowerCase() !== this.providerConfig.owner.toLowerCase()
        ) {
          continue;
        }
        // Archived, converted away from an Issue, or Status cleared: legitimate board actions that
        // make the item invisible to every state-based scope. Omitting (rather than failing) lets
        // reconciliation stop the worker instead of erroring every tick.
        if (!inScope(node)) continue;

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
