import type { Result, TrackerError } from "../domain/errors.js";
import type { Issue, ServiceConfig } from "../domain/types.js";
import type { Logger } from "../logging/logger.js";

/**
 * Issue tracker adapter contract (SPEC.md 11.1). Both operations return `ok(Issue[])` or a
 * {@link TrackerError}; the orchestrator relies only on success vs. failure.
 */
export interface TrackerAdapter {
  readonly kind: string;

  /**
   * Return normalized issues visible in the configured scope with any of `stateNames`.
   * An empty `stateNames` MUST return `ok([])` without a provider request.
   */
  fetchIssuesByStates(stateNames: string[]): Promise<Result<Issue[], TrackerError>>;

  /**
   * Return current normalized snapshots for the given opaque dispatch IDs. IDs no longer visible
   * in scope are omitted (never invented). An empty `issueIds` MUST return `ok([])` without a
   * provider request. Unlike {@link fetchIssuesByStates}, a malformed *requested* record MUST
   * fail the whole call rather than being silently dropped.
   */
  fetchIssuesByIds(issueIds: string[]): Promise<Result<Issue[], TrackerError>>;

  /** Non-secret documented environment variable names to strip from the coding-agent child (SPEC.md 15.3). */
  secretEnvironmentNames(): string[];
}

export type TrackerAdapterFactory = (config: ServiceConfig, logger: Logger) => Result<TrackerAdapter, TrackerError>;

/**
 * `issue_routable(issue)` (SPEC.md 8.2): adapter-provided `dispatchable` plus required-label
 * matching. State/claim/concurrency checks are applied separately by the orchestrator.
 */
export function issueRoutable(issue: Issue, requiredLabels: string[]): boolean {
  if (!issue.dispatchable) return false;
  if (requiredLabels.length === 0) return true;
  const labelSet = new Set(issue.labels);
  return requiredLabels.every((label) => label.length > 0 && labelSet.has(label));
}
