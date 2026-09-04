import { Liquid } from "liquidjs";
import { WorkflowError } from "../domain/errors.js";
import type { Issue } from "../domain/types.js";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true
});

/**
 * Convert the internal camelCase {@link Issue} into the snake_case field names the prompt
 * template contract documents (SPEC.md 4.1.1, 12.1). Nested arrays/maps are preserved so
 * templates can iterate `issue.labels` / `issue.blocked_by`.
 */
export function issueToTemplateContext(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    native_ref: issue.nativeRef,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    assignee_id: issue.assigneeId,
    labels: issue.labels,
    blocked_by: issue.blockedBy.map((b) => ({ id: b.id, identifier: b.identifier, state: b.state })),
    dispatchable: issue.dispatchable,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt
  };
}

/**
 * Continuation guidance sent on later in-worker turns instead of resending the original task
 * prompt, which is already present in thread history (SPEC.md 7.1, 10.2, 10.3).
 */
export function buildContinuationGuidance(turnNumber: number, maxTurns: number): string {
  return [
    "Continue working on the same issue.",
    `This is turn ${turnNumber} of at most ${maxTurns} for this session.`,
    "If the issue is already fully handled, say so explicitly and stop making further changes."
  ].join(" ");
}

/**
 * Render the workflow prompt template (SPEC.md 5.4, 12). Strict variable/filter checking: unknown
 * variables or filters MUST fail rendering with `template_render_error`. Parse failures raise
 * `template_parse_error`.
 */
export async function renderPrompt(promptTemplate: string, issue: Issue, attempt: number | null): Promise<string> {
  const template = promptTemplate.trim().length > 0 ? promptTemplate : "You are working on an issue from the configured tracker.";

  let parsed;
  try {
    parsed = engine.parse(template);
  } catch (cause) {
    throw new WorkflowError("template_parse_error", `Failed to parse prompt template: ${String(cause)}`, { cause });
  }

  try {
    return await engine.render(parsed, { issue: issueToTemplateContext(issue), attempt: attempt ?? null });
  } catch (cause) {
    throw new WorkflowError("template_render_error", `Failed to render prompt template: ${String(cause)}`, { cause });
  }
}
