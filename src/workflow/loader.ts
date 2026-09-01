import { promises as fs } from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { WorkflowError } from "../domain/errors.js";
import type { WorkflowDefinition } from "../domain/types.js";

/**
 * Workflow file path resolution (SPEC.md 5.1):
 * 1. Explicit application/runtime setting.
 * 2. Default: `WORKFLOW.md` in the current process working directory.
 */
export function resolveWorkflowPath(explicitPath?: string | null): string {
  const chosen = explicitPath && explicitPath.trim().length > 0 ? explicitPath : path.join(process.cwd(), "WORKFLOW.md");
  return path.resolve(chosen);
}

const FRONT_MATTER_DELIMITER = "---";

function splitFrontMatter(raw: string): { frontMatterYaml: string | null; body: string } {
  const lines = raw.split(/\r\n|\n/);
  if (lines.length === 0 || lines[0]?.trim() !== FRONT_MATTER_DELIMITER) {
    return { frontMatterYaml: null, body: raw };
  }

  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === FRONT_MATTER_DELIMITER);
  if (closingIndex === -1) {
    // Unterminated front matter: treat entire file as prompt body per a defensive reading of 5.2 —
    // but this is more useful surfaced as a parse error than silently swallowed.
    throw new WorkflowError("workflow_parse_error", "Unterminated YAML front matter block (missing closing '---').");
  }

  const frontMatterLines = lines.slice(1, closingIndex + 1);
  const bodyLines = lines.slice(closingIndex + 2);
  return { frontMatterYaml: frontMatterLines.join("\n"), body: bodyLines.join("\n") };
}

/**
 * Load and parse a WORKFLOW.md file (SPEC.md 5.2).
 * Throws {@link WorkflowError} with a stable category on any failure.
 */
export async function loadWorkflowFile(filePath: string): Promise<WorkflowDefinition> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (cause) {
    throw new WorkflowError("missing_workflow_file", `Cannot read workflow file at ${filePath}`, { cause });
  }

  const { frontMatterYaml, body } = splitFrontMatter(raw);

  if (frontMatterYaml === null) {
    return { config: {}, promptTemplate: body.trim() };
  }

  let decoded: unknown;
  try {
    decoded = yaml.load(frontMatterYaml);
  } catch (cause) {
    throw new WorkflowError("workflow_parse_error", `Failed to parse YAML front matter in ${filePath}`, { cause });
  }

  if (decoded === null || decoded === undefined) {
    decoded = {};
  }

  if (typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      `YAML front matter in ${filePath} must decode to a map/object, got ${Array.isArray(decoded) ? "array" : typeof decoded}`
    );
  }

  return { config: decoded as Record<string, unknown>, promptTemplate: body.trim() };
}
