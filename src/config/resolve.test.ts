import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { buildServiceConfig, expandPathValue, resolveVarIndirection } from "./resolve.js";
import { ConfigError } from "../domain/errors.js";

describe("buildServiceConfig", () => {
  it("applies documented defaults when optional values are missing", () => {
    const config = buildServiceConfig({}, "/repo");
    expect(config.polling.intervalMs).toBe(30000);
    expect(config.hooks.timeoutMs).toBe(60000);
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect(config.agent.maxTurns).toBe(20);
    expect(config.agent.maxRetryBackoffMs).toBe(300000);
    expect(config.codex.command).toBe("codex app-server");
    expect(config.codex.turnTimeoutMs).toBe(3600000);
    expect(config.codex.readTimeoutMs).toBe(5000);
    expect(config.codex.stallTimeoutMs).toBe(300000);
    expect(config.workspace.root).toBe(path.join(os.tmpdir(), "symphony_workspaces"));
  });

  it("preserves codex.command as a shell command string", () => {
    const config = buildServiceConfig({ codex: { command: "my-agent --flag foo" } }, "/repo");
    expect(config.codex.command).toBe("my-agent --flag foo");
  });

  it("rejects an empty codex.command", () => {
    expect(() => buildServiceConfig({ codex: { command: "" } }, "/repo")).toThrow(ConfigError);
  });

  it("resolves relative workspace.root against the WORKFLOW.md directory", () => {
    const config = buildServiceConfig({ workspace: { root: "./workspaces" } }, "/repo/dir");
    expect(config.workspace.root).toBe(path.resolve("/repo/dir", "workspaces"));
  });

  it("normalizes per-state concurrency overrides and drops invalid entries", () => {
    const config = buildServiceConfig(
      {
        agent: {
          max_concurrent_agents_by_state: {
            " In Review ": 3,
            "Blocked": -1,
            "QA": "not a number",
            "Todo": 5
          }
        }
      },
      "/repo"
    );
    expect(config.agent.maxConcurrentAgentsByState).toEqual({ "in review": 3, todo: 5 });
  });

  it("lowercases and trims required_labels", () => {
    const config = buildServiceConfig({ tracker: { required_labels: [" Symphony ", "AUTO"] } }, "/repo");
    expect(config.tracker.requiredLabels).toEqual(["symphony", "auto"]);
  });
});

describe("$VAR indirection", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("resolves a whole-string $VAR_NAME reference from the environment", () => {
    process.env.MY_SECRET = "shh";
    expect(resolveVarIndirection("$MY_SECRET")).toBe("shh");
  });

  it("treats an empty resolved secret as missing", () => {
    process.env.MY_SECRET = "";
    expect(resolveVarIndirection("$MY_SECRET")).toBeUndefined();
  });

  it("leaves non-$VAR strings untouched", () => {
    expect(resolveVarIndirection("literal-value")).toBe("literal-value");
  });

  it("expands ~ to the home directory for path values", () => {
    expect(expandPathValue("~/workspaces")).toBe(path.join(os.homedir(), "workspaces"));
  });
});
