import { describe, expect, it } from "vitest";
import { buildContinuationGuidance, renderPrompt } from "./render.js";
import { WorkflowError } from "../domain/errors.js";
import type { Issue } from "../domain/types.js";

const issue: Issue = {
  id: "issue-1",
  nativeRef: { team: "ENG" },
  identifier: "ENG-1",
  title: "Fix the bug",
  description: "It is broken",
  priority: 2,
  state: "Todo",
  branchName: "eng-1-fix-the-bug",
  url: "https://example.com/ENG-1",
  assigneeId: null,
  labels: ["symphony", "bug"],
  blockedBy: [{ id: "issue-0", identifier: "ENG-0", state: "Done" }],
  dispatchable: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z"
};

describe("renderPrompt", () => {
  it("renders issue and attempt variables", async () => {
    const rendered = await renderPrompt("Work on {{ issue.identifier }}: {{ issue.title }} (attempt {{ attempt }})", issue, 2);
    expect(rendered).toBe("Work on ENG-1: Fix the bug (attempt 2)");
  });

  it("renders null attempt on the first run", async () => {
    const rendered = await renderPrompt("attempt={{ attempt }}", issue, null);
    expect(rendered).toBe("attempt=");
  });

  it("allows iterating labels and blocked_by", async () => {
    const rendered = await renderPrompt(
      "{% for l in issue.labels %}{{ l }},{% endfor %}|{% for b in issue.blocked_by %}{{ b.identifier }}{% endfor %}",
      issue,
      null
    );
    expect(rendered).toBe("symphony,bug,|ENG-0");
  });

  it("falls back to a minimal prompt when the template is empty", async () => {
    const rendered = await renderPrompt("", issue, null);
    expect(rendered).toBe("You are working on an issue from the configured tracker.");
  });

  it("fails rendering on an unknown variable (strict mode)", async () => {
    await expect(renderPrompt("{{ issue.nonexistent_field_xyz }}", issue, null)).rejects.toBeInstanceOf(WorkflowError);
  });

  it("fails rendering on an unknown filter (strict mode)", async () => {
    await expect(renderPrompt("{{ issue.title | totally_unknown_filter }}", issue, null)).rejects.toBeInstanceOf(WorkflowError);
  });

  it("fails parsing on malformed template syntax", async () => {
    await expect(renderPrompt("{{ issue.title", issue, null)).rejects.toMatchObject({ category: "template_parse_error" });
  });
});

describe("buildContinuationGuidance", () => {
  it("mentions the current turn and the cap", () => {
    const guidance = buildContinuationGuidance(3, 20);
    expect(guidance).toContain("turn 3 of at most 20");
  });
});
