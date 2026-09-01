import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadWorkflowFile, resolveWorkflowPath } from "./loader.js";
import { WorkflowError } from "../domain/errors.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveWorkflowPath", () => {
  it("uses the explicit path when provided", () => {
    expect(resolveWorkflowPath("/tmp/custom/WORKFLOW.md")).toBe(path.resolve("/tmp/custom/WORKFLOW.md"));
  });

  it("defaults to WORKFLOW.md in the cwd", () => {
    expect(resolveWorkflowPath(null)).toBe(path.resolve(process.cwd(), "WORKFLOW.md"));
  });
});

describe("loadWorkflowFile", () => {
  it("returns missing_workflow_file for a nonexistent path", async () => {
    await expect(loadWorkflowFile("/nonexistent/WORKFLOW.md")).rejects.toMatchObject({
      name: "WorkflowError",
      category: "missing_workflow_file"
    });
  });

  it("parses front matter and trims the prompt body", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "WORKFLOW.md");
      await writeFile(
        file,
        ["---", "tracker:", "  kind: mock", "polling:", "  interval_ms: 1000", "---", "", "  Do the thing.  ", ""].join("\n")
      );

      const workflow = await loadWorkflowFile(file);
      expect(workflow.config).toEqual({ tracker: { kind: "mock" }, polling: { interval_ms: 1000 } });
      expect(workflow.promptTemplate).toBe("Do the thing.");
    });
  });

  it("treats a file with no front matter as an empty-config prompt body", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "WORKFLOW.md");
      await writeFile(file, "Just a prompt, no front matter.");

      const workflow = await loadWorkflowFile(file);
      expect(workflow.config).toEqual({});
      expect(workflow.promptTemplate).toBe("Just a prompt, no front matter.");
    });
  });

  it("rejects invalid YAML front matter", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "WORKFLOW.md");
      await writeFile(file, ["---", "tracker: [unterminated", "---", "body"].join("\n"));

      const error = await loadWorkflowFile(file).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).category).toBe("workflow_parse_error");
    });
  });

  it("rejects non-map front matter", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "WORKFLOW.md");
      await writeFile(file, ["---", "- one", "- two", "---", "body"].join("\n"));

      const error = await loadWorkflowFile(file).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).category).toBe("workflow_front_matter_not_a_map");
    });
  });
});
