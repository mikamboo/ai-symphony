import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinearTrackerAdapter } from "./linear.js";
import { buildServiceConfig } from "../config/resolve.js";
import { createLogger } from "../logging/logger.js";

const logger = createLogger({ test: true });

async function startCapturingServer(): Promise<{ server: Server; endpoint: string; lastVariables: () => Record<string, unknown> }> {
  let captured: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { variables: Record<string, unknown> };
      captured = body.variables;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind test server");
  return { server, endpoint: `http://127.0.0.1:${address.port}`, lastVariables: () => captured };
}

describe("LinearTrackerAdapter project scoping", () => {
  let server: Server;
  let endpoint: string;
  let lastVariables: () => Record<string, unknown>;

  beforeEach(async () => {
    ({ server, endpoint, lastVariables } = await startCapturingServer());
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function buildAdapter(projectId: string) {
    const config = buildServiceConfig(
      {
        tracker: {
          kind: "linear",
          provider: { api_key: "test-key", team_key: "ENG", project_id: projectId, endpoint }
        }
      },
      "/tmp"
    );
    const result = LinearTrackerAdapter.create(config, logger);
    if (!result.ok) throw new Error(`adapter construction failed: ${result.error.message}`);
    return result.value;
  }

  it("matches project.id when project_id looks like a UUID", async () => {
    const adapter = buildAdapter("550e8400-e29b-41d4-a716-446655440000");
    const result = await adapter.fetchIssuesByStates(["Backlog"]);
    expect(result.ok).toBe(true);
    const filter = lastVariables().filter as { project?: Record<string, unknown> };
    expect(filter.project).toEqual({ id: { eq: "550e8400-e29b-41d4-a716-446655440000" } });
  });

  it("matches project.slugId when project_id is the URL slug, not a UUID", async () => {
    const adapter = buildAdapter("a1b2c3d4");
    const result = await adapter.fetchIssuesByStates(["Backlog"]);
    expect(result.ok).toBe(true);
    const filter = lastVariables().filter as { project?: Record<string, unknown> };
    expect(filter.project).toEqual({ slugId: { eq: "a1b2c3d4" } });
  });

  it("omits the project filter entirely when project_id is unset", async () => {
    const config = buildServiceConfig(
      { tracker: { kind: "linear", provider: { api_key: "test-key", team_key: "ENG", endpoint } } },
      "/tmp"
    );
    const result = LinearTrackerAdapter.create(config, logger);
    if (!result.ok) throw new Error(`adapter construction failed: ${result.error.message}`);
    await result.value.fetchIssuesByStates(["Backlog"]);
    const filter = lastVariables().filter as Record<string, unknown>;
    expect(filter.project).toBeUndefined();
  });
});
