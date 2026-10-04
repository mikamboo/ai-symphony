import { describe, expect, it } from "vitest";
import { GitHubTrackerAdapter } from "./github.js";
import { postGraphql } from "./graphql.js";
import { buildServiceConfig } from "../config/resolve.js";
import { createLogger } from "../logging/logger.js";

/**
 * Real Integration Profile (SPEC.md 17.8) for the GitHub Projects adapter. Unlike Linear, GitHub
 * authenticates before validating a query, so there is no credential-free schema probe: this needs
 * a real token and a real Project.
 *
 * What it proves that unit tests can't:
 * - both GraphQL documents are accepted by the live API (schema + `ProjectV2Owner` resolution);
 * - the server-side Projects filter string (`is:issue status:Todo,"In Progress"`) selects exactly
 *   what the local Status match selects -- i.e. GitHub's filter syntax is what we assume. If this
 *   fails, operators can set `server_filter: false` while the syntax is fixed.
 *
 * Opt-in only; skipped (not silently passed) by default. Run with:
 *   SYMPHONY_TEST_LIVE_GITHUB=1 GITHUB_TOKEN=... \
 *   SYMPHONY_TEST_GITHUB_OWNER=<org-or-user> SYMPHONY_TEST_GITHUB_PROJECT_NUMBER=<n> \
 *   [SYMPHONY_TEST_GITHUB_STATUS_FIELD=Status] \
 *   pnpm vitest run src/tracker/github.live.test.ts
 *
 * Read-only. Most useful against a board with a few Issue items across at least two Status options
 * (ideally one whose name contains a space), plus a draft or PR item to confirm they're excluded.
 */
const live = process.env.SYMPHONY_TEST_LIVE_GITHUB === "1";
const owner = process.env.SYMPHONY_TEST_GITHUB_OWNER ?? "";
const projectNumber = Number(process.env.SYMPHONY_TEST_GITHUB_PROJECT_NUMBER);
const statusField = process.env.SYMPHONY_TEST_GITHUB_STATUS_FIELD ?? "Status";
const logger = createLogger({ test: true });

function buildAdapter(serverFilter: boolean): GitHubTrackerAdapter {
  const config = buildServiceConfig(
    {
      tracker: {
        kind: "github",
        provider: { owner, project_number: projectNumber, status_field: statusField, server_filter: serverFilter }
      }
    },
    "/tmp"
  );
  const result = GitHubTrackerAdapter.create(config, logger);
  if (!result.ok) throw new Error(`adapter construction failed: ${result.error.message}`);
  return result.value;
}

async function statusOptions(): Promise<string[]> {
  const result = await postGraphql<{
    repositoryOwner: { projectV2?: { field: { options?: { name: string }[] } | null } | null } | null;
  }>({
    provider: "GitHub",
    endpoint: "https://api.github.com/graphql",
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`, "User-Agent": "symphony-live-test" },
    query: `
      query($owner: String!, $number: Int!, $field: String!) {
        repositoryOwner(login: $owner) {
          ... on ProjectV2Owner {
            projectV2(number: $number) { field(name: $field) { ... on ProjectV2SingleSelectField { options { name } } } }
          }
        }
      }
    `,
    variables: { owner, number: projectNumber, field: statusField }
  });
  if (!result.ok) throw new Error(`status option lookup failed: ${result.error.message}`);
  const options = result.value.repositoryOwner?.projectV2?.field?.options;
  if (!options || options.length === 0) throw new Error(`Project field '${statusField}' has no single-select options`);
  return options.map((o) => o.name);
}

const ids = (r: { ok: boolean; value?: { id: string }[] }) => (r.ok && r.value ? r.value.map((i) => i.id).sort() : null);

describe.skipIf(!live)("GitHubTrackerAdapter live (SPEC.md 17.8)", () => {
  it("has the required environment", () => {
    expect(process.env.GITHUB_TOKEN, "GITHUB_TOKEN").toBeTruthy();
    expect(owner, "SYMPHONY_TEST_GITHUB_OWNER").toBeTruthy();
    expect(Number.isInteger(projectNumber) && projectNumber > 0, "SYMPHONY_TEST_GITHUB_PROJECT_NUMBER").toBe(true);
  });

  it("server-side filtering selects exactly what local filtering selects, per option and combined", async () => {
    const options = await statusOptions();
    const filtered = buildAdapter(true);
    const unfiltered = buildAdapter(false);

    for (const states of [options, ...options.map((o) => [o])]) {
      const viaServer = await filtered.fetchIssuesByStates(states);
      const viaLocal = await unfiltered.fetchIssuesByStates(states);
      expect(viaServer.ok, viaServer.ok ? "" : viaServer.error.message).toBe(true);
      expect(viaLocal.ok, viaLocal.ok ? "" : viaLocal.error.message).toBe(true);
      expect(ids(viaServer), `states ${JSON.stringify(states)}`).toEqual(ids(viaLocal));
    }
  }, 120_000);

  it("refreshes listed items by id with the same state", async () => {
    const adapter = buildAdapter(true);
    const listed = await adapter.fetchIssuesByStates(await statusOptions());
    if (!listed.ok) throw new Error(listed.error.message);
    const sample = listed.value.slice(0, 20);

    const refreshed = await adapter.fetchIssuesByIds(sample.map((i) => i.id));
    if (!refreshed.ok) throw new Error(refreshed.error.message);
    expect(refreshed.value.map((i) => [i.id, i.state]).sort()).toEqual(sample.map((i) => [i.id, i.state]).sort());
  }, 120_000);
});
