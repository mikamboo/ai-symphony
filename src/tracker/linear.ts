import { err, ok, TrackerError, type Result } from "../domain/errors.js";
import type { BlockerRef, Issue, ServiceConfig } from "../domain/types.js";
import type { Logger } from "../logging/logger.js";
import { resolveVarIndirection } from "../config/resolve.js";
import type { TrackerAdapter } from "./adapter.js";

/**
 * Linear tracker adapter profile (SPEC.md 11.2 compact profile; see also docs/adapters/linear.md).
 *
 * `tracker.kind`: `"linear"`
 *
 * `tracker.provider` keys:
 * - `api_key` (string, secret): Linear personal API key or OAuth access token. Supports `$VAR_NAME`
 *   indirection. Falls back to the `LINEAR_API_KEY` environment variable when omitted. Empty
 *   resolution is treated as missing (SPEC.md 5.3.1).
 * - `team_id` (string, optional): Linear team UUID to scope issues to. One of `team_id`/`team_key`
 *   SHOULD be set; omitting both queries across every team visible to the API key.
 * - `team_key` (string, optional): Linear team key (e.g. `"ENG"`), resolved to a team ID at
 *   adapter construction time via a lazy lookup.
 * - `project_id` (string, optional): Linear project UUID to further scope issues.
 * - `page_size` (integer, default 100): GraphQL page size for pagination.
 * - `endpoint` (string, default `"https://api.linear.app/graphql"`): override for testing.
 *
 * `id` / `native_ref` mapping: `id` is the Linear issue UUID (`issue.id`); `native_ref` carries
 * `{ team_id, team_key, url }`, all non-secret.
 *
 * `dispatchable`: `true` for every issue returned within the configured team/project scope; this
 * adapter does not implement assignment- or board-based routing beyond that scope.
 *
 * Secrets: declares `LINEAR_API_KEY` via {@link secretEnvironmentNames} for removal from the
 * coding-agent child environment (SPEC.md 15.3). This adapter does not ship provider-native agent
 * tools in this conformance pass; it never writes to Linear.
 */

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";
const MAX_PAGES = 50;

interface LinearProviderConfig {
  apiKey: string;
  teamId: string | null;
  teamKey: string | null;
  projectId: string | null;
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

function parseProviderConfig(provider: Record<string, unknown>): Result<LinearProviderConfig, TrackerError> {
  const apiKey = resolveSecret(provider.api_key, "LINEAR_API_KEY");
  if (!apiKey) {
    return err(
      new TrackerError("missing_tracker_secret", "tracker.provider.api_key (or $LINEAR_API_KEY) is required and must be non-empty")
    );
  }

  const teamId = typeof provider.team_id === "string" && provider.team_id.length > 0 ? provider.team_id : null;
  const teamKey = typeof provider.team_key === "string" && provider.team_key.length > 0 ? provider.team_key : null;
  const projectId = typeof provider.project_id === "string" && provider.project_id.length > 0 ? provider.project_id : null;
  const pageSize = typeof provider.page_size === "number" && provider.page_size > 0 ? provider.page_size : 100;
  const endpoint = typeof provider.endpoint === "string" && provider.endpoint.length > 0 ? provider.endpoint : DEFAULT_ENDPOINT;

  return ok({ apiKey, teamId, teamKey, projectId, pageSize, endpoint });
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: { name: string } | null;
  branchName: string | null;
  url: string | null;
  assignee: { id: string } | null;
  labels: { nodes: { name: string }[] } | null;
  inverseRelations: { nodes: { type: string; relatedIssue: { id: string; identifier: string; state: { name: string } | null } }[] } | null;
  team: { id: string; key: string } | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  state { name }
  branchName
  url
  assignee { id }
  labels { nodes { name } }
  inverseRelations(filter: { type: { eq: "blocks" } }) {
    nodes { type relatedIssue { id identifier state { name } } }
  }
  team { id key }
  createdAt
  updatedAt
`;

function toBlockedBy(node: LinearIssueNode): BlockerRef[] {
  if (!node.inverseRelations) return [];
  return node.inverseRelations.nodes
    .filter((r) => r.type === "blocks")
    .map((r) => ({
      id: r.relatedIssue.id,
      identifier: r.relatedIssue.identifier,
      state: r.relatedIssue.state?.name ?? null
    }));
}

function normalizeIssue(node: LinearIssueNode): Issue | null {
  if (!node.id || !node.identifier || !node.title || !node.state?.name) return null;

  const labels = (node.labels?.nodes ?? [])
    .map((l) => l.name.trim().toLowerCase())
    .filter((l) => l.length > 0);

  return {
    id: node.id,
    nativeRef: { team_id: node.team?.id ?? null, team_key: node.team?.key ?? null, url: node.url ?? null },
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority: node.priority && node.priority > 0 ? node.priority : null,
    state: node.state.name,
    branchName: node.branchName ?? null,
    url: node.url ?? null,
    assigneeId: node.assignee?.id ?? null,
    labels: Array.from(new Set(labels)),
    blockedBy: toBlockedBy(node),
    dispatchable: true,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null
  };
}

export class LinearTrackerAdapter implements TrackerAdapter {
  readonly kind = "linear";
  private readonly providerConfig: LinearProviderConfig;

  private constructor(
    providerConfig: LinearProviderConfig,
    private readonly logger: Logger
  ) {
    this.providerConfig = providerConfig;
  }

  static create(config: ServiceConfig, logger: Logger): Result<LinearTrackerAdapter, TrackerError> {
    const parsed = parseProviderConfig(config.tracker.provider);
    if (!parsed.ok) return parsed;
    return ok(new LinearTrackerAdapter(parsed.value, logger));
  }

  secretEnvironmentNames(): string[] {
    return ["LINEAR_API_KEY"];
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<Result<T, TrackerError>> {
    let response: Response;
    try {
      response = await fetch(this.providerConfig.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.providerConfig.apiKey
        },
        body: JSON.stringify({ query, variables })
      });
    } catch (cause) {
      return err(new TrackerError("tracker_request", `Linear request failed: ${String(cause)}`, { cause, retryable: true }));
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      return err(
        new TrackerError("tracker_rate_limited", "Linear API rate limit exceeded", {
          retryable: true,
          retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined
        })
      );
    }

    if (!response.ok) {
      return err(new TrackerError("tracker_status", `Linear API returned HTTP ${response.status}`, { retryable: response.status >= 500 }));
    }

    let body: { data?: T; errors?: { message: string }[] };
    try {
      body = (await response.json()) as { data?: T; errors?: { message: string }[] };
    } catch (cause) {
      return err(new TrackerError("tracker_response", "Linear API returned invalid JSON", { cause }));
    }

    if (body.errors && body.errors.length > 0) {
      return err(new TrackerError("tracker_response", `Linear API error: ${body.errors.map((e) => e.message).join("; ")}`));
    }
    if (body.data === undefined) {
      return err(new TrackerError("tracker_response", "Linear API response missing 'data'"));
    }

    return ok(body.data);
  }

  private buildFilter(): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (this.providerConfig.teamId) filter.team = { id: { eq: this.providerConfig.teamId } };
    else if (this.providerConfig.teamKey) filter.team = { key: { eq: this.providerConfig.teamKey } };
    if (this.providerConfig.projectId) filter.project = { id: { eq: this.providerConfig.projectId } };
    return filter;
  }

  private async fetchAllScopedIssues(): Promise<Result<LinearIssueNode[], TrackerError>> {
    const query = `
      query ScopedIssues($first: Int!, $after: String, $filter: IssueFilter) {
        issues(first: $first, after: $after, filter: $filter) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    const all: LinearIssueNode[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.graphql<{ issues: { nodes: LinearIssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
        query,
        { first: this.providerConfig.pageSize, after, filter: this.buildFilter() }
      );
      if (!result.ok) return result;

      all.push(...result.value.issues.nodes);
      if (!result.value.issues.pageInfo.hasNextPage) return ok(all);
      after = result.value.issues.pageInfo.endCursor ?? undefined;
      if (!after) return ok(all);
    }

    return err(new TrackerError("tracker_pagination", `Exceeded max pagination depth (${MAX_PAGES} pages) while listing Linear issues`));
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Result<Issue[], TrackerError>> {
    if (stateNames.length === 0) return ok([]);

    const scoped = await this.fetchAllScopedIssues();
    if (!scoped.ok) return scoped;

    const wanted = new Set(stateNames.map((s) => s.trim().toLowerCase()));
    const issues: Issue[] = [];
    for (const node of scoped.value) {
      const stateName = node.state?.name;
      if (!stateName || !wanted.has(stateName.trim().toLowerCase())) continue;

      const normalized = normalizeIssue(node);
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

    const query = `
      query IssuesByIds($ids: [ID!]!) {
        issues(filter: { id: { in: $ids } }, first: ${issueIds.length}) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `;

    const result = await this.graphql<{ issues: { nodes: LinearIssueNode[] } }>(query, { ids: issueIds });
    if (!result.ok) return result;

    const issues: Issue[] = [];
    for (const node of result.value.issues.nodes) {
      const normalized = normalizeIssue(node);
      if (!normalized) {
        return err(new TrackerError("tracker_response", `Linear returned a malformed record for requested issue id ${node.id ?? "unknown"}`));
      }
      issues.push(normalized);
    }
    return ok(issues);
  }
}
