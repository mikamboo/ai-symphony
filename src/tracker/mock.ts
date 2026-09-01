import { ok, err, TrackerError, type Result } from "../domain/errors.js";
import type { Issue } from "../domain/types.js";
import type { TrackerAdapter } from "./adapter.js";

/**
 * In-memory tracker adapter for tests and local experimentation (SPEC.md 17.8 "Real Integration
 * Profile" recommends a real adapter for production validation; this one is deliberately not it).
 */
export class MockTrackerAdapter implements TrackerAdapter {
  readonly kind = "mock";
  private issues = new Map<string, Issue>();
  private forcedError: TrackerError | null = null;

  seed(issues: Issue[]): void {
    for (const issue of issues) this.issues.set(issue.id, issue);
  }

  upsert(issue: Issue): void {
    this.issues.set(issue.id, issue);
  }

  remove(issueId: string): void {
    this.issues.delete(issueId);
  }

  failNextCallsWith(error: TrackerError | null): void {
    this.forcedError = error;
  }

  secretEnvironmentNames(): string[] {
    return [];
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Result<Issue[], TrackerError>> {
    if (this.forcedError) return err(this.forcedError);
    if (stateNames.length === 0) return ok([]);
    const wanted = new Set(stateNames.map((s) => s.trim().toLowerCase()));
    return ok([...this.issues.values()].filter((i) => wanted.has(i.state.trim().toLowerCase())));
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Result<Issue[], TrackerError>> {
    if (this.forcedError) return err(this.forcedError);
    if (issueIds.length === 0) return ok([]);
    const found: Issue[] = [];
    for (const id of issueIds) {
      const issue = this.issues.get(id);
      if (issue) found.push(issue);
    }
    return ok(found);
  }
}
