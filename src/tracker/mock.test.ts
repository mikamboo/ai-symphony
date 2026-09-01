import { describe, expect, it } from "vitest";
import { MockTrackerAdapter } from "./mock.js";
import { issueRoutable } from "./adapter.js";
import { TrackerError } from "../domain/errors.js";
import type { Issue } from "../domain/types.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "id-1",
    nativeRef: null,
    identifier: "ABC-1",
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

describe("MockTrackerAdapter", () => {
  it("returns an empty result without inspecting state for empty state-name lists", async () => {
    const tracker = new MockTrackerAdapter();
    tracker.seed([makeIssue()]);
    const result = await tracker.fetchIssuesByStates([]);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("returns an empty result for empty id lists", async () => {
    const tracker = new MockTrackerAdapter();
    tracker.seed([makeIssue()]);
    const result = await tracker.fetchIssuesByIds([]);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("filters by state case-insensitively", async () => {
    const tracker = new MockTrackerAdapter();
    tracker.seed([makeIssue({ id: "1", state: "Todo" }), makeIssue({ id: "2", state: "Done" })]);
    const result = await tracker.fetchIssuesByStates(["todo"]);
    expect(result.ok && result.value.map((i) => i.id)).toEqual(["1"]);
  });

  it("omits IDs no longer visible rather than inventing a state", async () => {
    const tracker = new MockTrackerAdapter();
    tracker.seed([makeIssue({ id: "1" })]);
    const result = await tracker.fetchIssuesByIds(["1", "missing"]);
    expect(result.ok && result.value.map((i) => i.id)).toEqual(["1"]);
  });

  it("surfaces a forced tracker error", async () => {
    const tracker = new MockTrackerAdapter();
    tracker.failNextCallsWith(new TrackerError("tracker_request", "boom"));
    const result = await tracker.fetchIssuesByStates(["todo"]);
    expect(result.ok).toBe(false);
  });
});

describe("issueRoutable", () => {
  it("is false when dispatchable is false regardless of labels", () => {
    expect(issueRoutable(makeIssue({ dispatchable: false }), [])).toBe(false);
  });

  it("requires every configured required label, case-insensitively pre-normalized", () => {
    const issue = makeIssue({ labels: ["symphony", "auto"] });
    expect(issueRoutable(issue, ["symphony", "auto"])).toBe(true);
    expect(issueRoutable(issue, ["symphony", "missing"])).toBe(false);
  });

  it("is true with no required labels configured", () => {
    expect(issueRoutable(makeIssue({ labels: [] }), [])).toBe(true);
  });
});
