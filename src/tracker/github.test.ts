import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildItemsFilter, GitHubTrackerAdapter } from "./github.js";
import { buildServiceConfig } from "../config/resolve.js";
import { createLogger } from "../logging/logger.js";

const logger = createLogger({ test: true });

interface Captured {
  query: string;
  variables: Record<string, unknown>;
  authorization: string | undefined;
}

type Responder = (req: Captured) => { status?: number; headers?: Record<string, string>; body: unknown };

async function startServer(responder: Responder): Promise<{ server: Server; endpoint: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query: string; variables: Record<string, unknown> };
      const captured = { ...parsed, authorization: req.headers.authorization };
      requests.push(captured);
      const out = responder(captured);
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json", ...(out.headers ?? {}) });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind test server");
  return { server, endpoint: `http://127.0.0.1:${address.port}`, requests };
}

function issueItem(
  itemId: string,
  status: string | null,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: itemId,
    fieldValueByName: status === null ? null : { name: status },
    content: {
      __typename: "Issue",
      id: `I_${itemId}`,
      number: 7,
      title: "Fix the thing",
      body: "details",
      url: "https://github.com/acme/app/issues/7",
      state: "OPEN",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      repository: { nameWithOwner: "acme/app" },
      labels: { nodes: [{ name: " Bug " }, { name: "bug" }] },
      assignees: { nodes: [{ id: "U_1" }] },
      blockedBy: { nodes: [{ id: "I_9", number: 9, state: "CLOSED", repository: { nameWithOwner: "acme/lib" } }] },
      ...overrides
    }
  };
}

const STATUS_FIELD = {
  __typename: "ProjectV2SingleSelectField",
  options: [{ name: "Todo" }, { name: "In Progress" }, { name: "Done" }]
};

function page(nodes: unknown[], hasNextPage = false, endCursor: string | null = null, field: unknown = STATUS_FIELD) {
  return { data: { repositoryOwner: { projectV2: { field, items: { nodes, pageInfo: { hasNextPage, endCursor } } } } } };
}

function buildAdapter(endpoint: string, provider: Record<string, unknown> = {}) {
  const config = buildServiceConfig(
    { tracker: { kind: "github", provider: { token: "test-token", owner: "acme", project_number: 3, endpoint, ...provider } } },
    "/tmp"
  );
  const result = GitHubTrackerAdapter.create(config, logger);
  if (!result.ok) throw new Error(`adapter construction failed: ${result.error.message}`);
  return result.value;
}

describe("GitHubTrackerAdapter config", () => {
  it("requires owner and a positive integer project_number", () => {
    for (const provider of [
      { token: "t", project_number: 1 },
      { token: "t", owner: "acme" },
      { token: "t", owner: "acme", project_number: "1" },
      { token: "t", owner: "acme", project_number: 0 }
    ]) {
      const config = buildServiceConfig({ tracker: { kind: "github", provider } }, "/tmp");
      const result = GitHubTrackerAdapter.create(config, logger);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.category).toBe("invalid_tracker_config");
    }
  });

  it("rejects a non-boolean server_filter", () => {
    const config = buildServiceConfig(
      { tracker: { kind: "github", provider: { token: "t", owner: "acme", project_number: 1, server_filter: "no" } } },
      "/tmp"
    );
    const result = GitHubTrackerAdapter.create(config, logger);
    expect(!result.ok && result.error.category).toBe("invalid_tracker_config");
  });

  it("requires a token when GITHUB_TOKEN is unset", () => {
    const saved = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const config = buildServiceConfig({ tracker: { kind: "github", provider: { owner: "acme", project_number: 1 } } }, "/tmp");
      const result = GitHubTrackerAdapter.create(config, logger);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.category).toBe("missing_tracker_secret");
    } finally {
      if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
    }
  });
});

describe("buildItemsFilter", () => {
  it("restricts to issues and ORs the states, quoting values that need it", () => {
    expect(buildItemsFilter("Status", ["Todo", "In Progress"], true)).toBe('is:issue status:Todo,"In Progress"');
  });

  it("falls back to is:issue when the field name or a value can't be expressed safely", () => {
    expect(buildItemsFilter("Dev Stage", ["Todo"], true)).toBe("is:issue");
    expect(buildItemsFilter("Status", ['Say "hi"'], true)).toBe("is:issue");
    expect(buildItemsFilter("Status", ["  "], true)).toBe("is:issue");
  });

  it("sends no filter at all when server_filter is off", () => {
    expect(buildItemsFilter("Status", ["Todo"], false)).toBe("");
  });
});

describe("GitHubTrackerAdapter requests", () => {
  let server: Server;
  let endpoint: string;
  let requests: Captured[];
  let responder: Responder;

  beforeEach(async () => {
    responder = () => ({ body: page([]) });
    ({ server, endpoint, requests } = await startServer((req) => responder(req)));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns ok([]) without a request for empty inputs", async () => {
    const adapter = buildAdapter(endpoint);
    expect(await adapter.fetchIssuesByStates([])).toEqual({ ok: true, value: [] });
    expect(await adapter.fetchIssuesByIds([])).toEqual({ ok: true, value: [] });
    expect(requests).toHaveLength(0);
  });

  it("sends bearer auth and the configured status field", async () => {
    const adapter = buildAdapter(endpoint, { status_field: "Stage" });
    await adapter.fetchIssuesByStates(["Todo"]);
    expect(requests[0]?.authorization).toBe("Bearer test-token");
    expect(requests[0]?.variables).toMatchObject({ owner: "acme", number: 3, statusField: "Stage", query: "is:issue stage:Todo", first: 100 });
  });

  it("filters by Status case-insensitively and normalizes issue items", async () => {
    responder = () => ({
      body: page([
        issueItem("PVTI_1", "Todo"),
        issueItem("PVTI_2", "Done"),
        issueItem("PVTI_3", null),
        { id: "PVTI_4", fieldValueByName: { name: "Todo" }, content: { __typename: "DraftIssue" } },
        { id: "PVTI_5", fieldValueByName: { name: "Todo" }, content: { __typename: "PullRequest" } },
        null
      ])
    });
    const result = await buildAdapter(endpoint).fetchIssuesByStates([" todo "]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toEqual({
      id: "PVTI_1",
      nativeRef: { issue_id: "I_PVTI_1", repository: "acme/app", number: 7, url: "https://github.com/acme/app/issues/7" },
      identifier: "acme/app#7",
      title: "Fix the thing",
      description: "details",
      priority: null,
      state: "Todo",
      branchName: null,
      url: "https://github.com/acme/app/issues/7",
      assigneeId: "U_1",
      labels: ["bug"],
      blockedBy: [{ id: "I_9", identifier: "acme/lib#9", state: "closed" }],
      dispatchable: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z"
    });
  });

  it("skips malformed issue items in state listings", async () => {
    responder = () => ({ body: page([issueItem("PVTI_1", "Todo", { title: "" }), issueItem("PVTI_2", "Todo")]) });
    const result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(result.ok && result.value.map((i) => i.id)).toEqual(["PVTI_2"]);
  });

  it("paginates with endCursor", async () => {
    responder = (req) =>
      req.variables.after === "c1" ? { body: page([issueItem("PVTI_2", "Todo")]) } : { body: page([issueItem("PVTI_1", "Todo")], true, "c1") };
    const result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(result.ok && result.value.map((i) => i.id)).toEqual(["PVTI_1", "PVTI_2"]);
    expect(requests).toHaveLength(2);
  });

  it("fails when the project is not visible", async () => {
    responder = () => ({ body: { data: { repositoryOwner: {} } } });
    const result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(!result.ok && result.error.category).toBe("tracker_response");
  });

  it("maps GraphQL errors, HTTP 5xx, and rate limits", async () => {
    responder = () => ({ body: { errors: [{ message: "boom" }] } });
    let result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(!result.ok && result.error.category).toBe("tracker_response");

    responder = () => ({ body: { errors: [{ type: "RATE_LIMITED", message: "slow down" }] } });
    result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(!result.ok && result.error.category).toBe("tracker_rate_limited");

    responder = () => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "5" }, body: {} });
    result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(!result.ok && result.error).toMatchObject({ category: "tracker_rate_limited", retryAfterMs: 5000 });

    responder = () => ({ status: 403, headers: { "retry-after": "60" }, body: {} });
    result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(!result.ok && result.error).toMatchObject({ category: "tracker_rate_limited", retryable: true, retryAfterMs: 60000 });

    responder = () => ({ status: 403, body: {} });
    result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(!result.ok && result.error).toMatchObject({ category: "tracker_status", retryable: false });

    responder = () => ({ status: 502, body: {} });
    result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(!result.ok && result.error).toMatchObject({ category: "tracker_status", retryable: true });
  });

  it("refreshes by item id, omitting items outside the configured project", async () => {
    const inProject = { project: { number: 3, owner: { login: "Acme" } } };
    responder = () => ({
      body: {
        data: {
          nodes: [
            { ...issueItem("PVTI_1", "In Progress"), ...inProject },
            { ...issueItem("PVTI_2", "Todo"), project: { number: 4, owner: { login: "acme" } } },
            null,
            {}
          ]
        }
      }
    });
    const result = await buildAdapter(endpoint).fetchIssuesByIds(["PVTI_1", "PVTI_2", "gone", "I_x"]);
    expect(result.ok && result.value.map((i) => [i.id, i.state])).toEqual([["PVTI_1", "In Progress"]]);
    expect(requests[0]?.variables.ids).toEqual(["PVTI_1", "PVTI_2", "gone", "I_x"]);
  });

  it("fails the whole refresh on a malformed requested record", async () => {
    responder = () => ({
      body: { data: { nodes: [{ ...issueItem("PVTI_1", "Todo", { title: "" }), project: { number: 3, owner: { login: "acme" } } }] } }
    });
    const result = await buildAdapter(endpoint).fetchIssuesByIds(["PVTI_1"]);
    expect(!result.ok && result.error.category).toBe("tracker_response");
  });

  it("omits (rather than fails on) a requested item whose Status was cleared", async () => {
    responder = () => ({
      body: { data: { nodes: [{ ...issueItem("PVTI_1", null), project: { number: 3, owner: { login: "acme" } } }] } }
    });
    expect(await buildAdapter(endpoint).fetchIssuesByIds(["PVTI_1"])).toEqual({ ok: true, value: [] });
  });

  it("fails loudly when the status field is missing or not single-select", async () => {
    responder = () => ({ body: page([issueItem("PVTI_1", "Todo")], false, null, null) });
    let result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(!result.ok && result.error.category).toBe("invalid_tracker_config");

    responder = () => ({ body: page([issueItem("PVTI_1", "Todo")], false, null, { __typename: "ProjectV2Field" }) });
    result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(!result.ok && result.error.message).toMatch(/single-select/);
  });

  it("warns once per configured state the status field does not offer", async () => {
    const adapter = buildAdapter(endpoint);
    const warn = vi.spyOn(logger, "warn");
    try {
      await adapter.fetchIssuesByStates(["Todo", "In progress ", "Blocked"]);
      await adapter.fetchIssuesByStates(["Blocked"]);
      const unknown = warn.mock.calls.filter(([event]) => event === "tracker.unknown_state").map(([, fields]) => fields?.state);
      expect(unknown).toEqual(["Blocked"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("marks closed issues non-dispatchable", async () => {
    responder = () => ({ body: page([issueItem("PVTI_1", "Todo", { state: "CLOSED" }), issueItem("PVTI_2", "Todo")]) });
    const result = await buildAdapter(endpoint).fetchIssuesByStates(["Todo"]);
    expect(result.ok && result.value.map((i) => [i.id, i.dispatchable])).toEqual([
      ["PVTI_1", false],
      ["PVTI_2", true]
    ]);
  });

  it("omits archived items from id refreshes", async () => {
    responder = () => ({
      body: { data: { nodes: [{ ...issueItem("PVTI_1", "Todo"), isArchived: true, project: { number: 3, owner: { login: "acme" } } }] } }
    });
    expect(await buildAdapter(endpoint).fetchIssuesByIds(["PVTI_1"])).toEqual({ ok: true, value: [] });
  });

  it("chunks id refreshes at 100", async () => {
    responder = () => ({ body: { data: { nodes: [] } } });
    const ids = Array.from({ length: 150 }, (_, i) => `PVTI_${i}`);
    await buildAdapter(endpoint).fetchIssuesByIds(ids);
    expect(requests.map((r) => (r.variables.ids as string[]).length)).toEqual([100, 50]);
  });
});
