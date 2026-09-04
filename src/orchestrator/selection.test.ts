import { describe, expect, it } from "vitest";
import { availableStateSlots, noAvailableSlots, shouldDispatch, sortForDispatch } from "./selection.js";
import { buildServiceConfig } from "../config/resolve.js";
import type { Issue, OrchestratorState } from "../domain/types.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "id",
    nativeRef: null,
    identifier: overrides.identifier ?? "ABC-1",
    title: "Title",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: null,
    updatedAt: null,
    ...overrides
  };
}

function emptyState(): OrchestratorState {
  return {
    pollIntervalMs: 30000,
    maxConcurrentAgents: 10,
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    codexTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    codexRateLimits: null
  };
}

describe("sortForDispatch", () => {
  it("sorts priority 1..4 ascending before everything else", () => {
    const issues = [makeIssue({ id: "a", priority: 4 }), makeIssue({ id: "b", priority: 1 }), makeIssue({ id: "c", priority: null })];
    expect(sortForDispatch(issues).map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("breaks ties by oldest created_at first", () => {
    const issues = [
      makeIssue({ id: "new", priority: 2, createdAt: "2026-01-02T00:00:00Z" }),
      makeIssue({ id: "old", priority: 2, createdAt: "2026-01-01T00:00:00Z" })
    ];
    expect(sortForDispatch(issues).map((i) => i.id)).toEqual(["old", "new"]);
  });

  it("breaks remaining ties by identifier", () => {
    const issues = [makeIssue({ id: "1", identifier: "B-1" }), makeIssue({ id: "2", identifier: "A-1" })];
    expect(sortForDispatch(issues).map((i) => i.identifier)).toEqual(["A-1", "B-1"]);
  });

  it("sorts out-of-range and null priorities after the 1..4 bucket, keeping relative order stable", () => {
    const issues = [makeIssue({ id: "a", priority: 9 }), makeIssue({ id: "b", priority: 1 }), makeIssue({ id: "c", priority: null })];
    const sorted = sortForDispatch(issues).map((i) => i.id);
    expect(sorted[0]).toBe("b");
    expect(new Set(sorted.slice(1))).toEqual(new Set(["a", "c"]));
  });
});

describe("shouldDispatch", () => {
  const config = buildServiceConfig(
    { tracker: { active_states: ["Todo"], terminal_states: ["Done"], required_labels: ["symphony"] } },
    "/repo"
  );

  it("rejects issues not in an active state", () => {
    expect(shouldDispatch(makeIssue({ state: "Backlog", labels: ["symphony"] }), emptyState(), config)).toBe(false);
  });

  it("rejects terminal-state issues even if also listed active", () => {
    const bothConfig = buildServiceConfig({ tracker: { active_states: ["Done"], terminal_states: ["Done"] } }, "/repo");
    expect(shouldDispatch(makeIssue({ state: "Done" }), emptyState(), bothConfig)).toBe(false);
  });

  it("rejects dispatchable=false issues", () => {
    expect(shouldDispatch(makeIssue({ dispatchable: false, labels: ["symphony"] }), emptyState(), config)).toBe(false);
  });

  it("requires configured labels case-insensitively after normalization", () => {
    expect(shouldDispatch(makeIssue({ labels: ["symphony"] }), emptyState(), config)).toBe(true);
    expect(shouldDispatch(makeIssue({ labels: [] }), emptyState(), config)).toBe(false);
  });

  it("rejects issues already running or claimed", () => {
    const state = emptyState();
    state.claimed.add("id");
    expect(shouldDispatch(makeIssue({ labels: ["symphony"] }), state, config)).toBe(false);
  });
});

describe("concurrency slots", () => {
  it("computes global available slots", () => {
    const config = buildServiceConfig({ agent: { max_concurrent_agents: 2 } }, "/repo");
    const state = emptyState();
    expect(noAvailableSlots(state, config)).toBe(false);
  });

  it("falls back to the global limit when no per-state override exists", () => {
    const config = buildServiceConfig({ agent: { max_concurrent_agents: 5 } }, "/repo");
    expect(availableStateSlots(emptyState(), config, "todo")).toBe(5);
  });

  it("honors a per-state override", () => {
    const config = buildServiceConfig({ agent: { max_concurrent_agents: 5, max_concurrent_agents_by_state: { todo: 1 } } }, "/repo");
    expect(availableStateSlots(emptyState(), config, "todo")).toBe(1);
  });
});
