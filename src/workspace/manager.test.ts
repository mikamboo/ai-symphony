import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager, assertWithinRoot } from "./manager.js";
import { deriveWorkspaceKey } from "./key.js";
import { buildServiceConfig } from "../config/resolve.js";
import { createLogger } from "../logging/logger.js";
import { WorkspaceError } from "../domain/errors.js";

const logger = createLogger({ test: true });

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-ws-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("deriveWorkspaceKey", () => {
  it("passes through identifiers that need no sanitization", () => {
    expect(deriveWorkspaceKey("ABC-123")).toBe("ABC-123");
  });

  it("sanitizes disallowed characters and appends a stable hash suffix", () => {
    const key = deriveWorkspaceKey("team/project#42");
    expect(key.startsWith("team_project_42_")).toBe(true);
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    // deterministic for the same input
    expect(deriveWorkspaceKey("team/project#42")).toBe(key);
  });

  it("keeps distinct identifiers that sanitize to the same text collision-resistant", () => {
    const keyA = deriveWorkspaceKey("a/b");
    const keyB = deriveWorkspaceKey("a?b");
    expect(keyA).not.toBe(keyB);
  });
});

describe("assertWithinRoot", () => {
  it("accepts a path nested under the root", () => {
    expect(() => assertWithinRoot("/root", "/root/child")).not.toThrow();
  });

  it("rejects a path outside the root", () => {
    expect(() => assertWithinRoot("/root", "/other")).toThrow(WorkspaceError);
    expect(() => assertWithinRoot("/root", "/root/../escaped")).toThrow(WorkspaceError);
  });
});

describe("WorkspaceManager", () => {
  it("computes a deterministic path per issue identifier", async () => {
    await withRoot(async (root) => {
      const config = buildServiceConfig({ workspace: { root } }, root);
      const manager = new WorkspaceManager(config, logger);
      const a = manager.pathForIdentifier("ABC-1");
      const b = manager.pathForIdentifier("ABC-1");
      expect(a.workspacePath).toBe(b.workspacePath);
      expect(a.workspacePath).toBe(path.join(root, "ABC-1"));
    });
  });

  it("creates a missing workspace directory and reuses an existing one", async () => {
    await withRoot(async (root) => {
      const config = buildServiceConfig({ workspace: { root } }, root);
      const manager = new WorkspaceManager(config, logger);

      const first = await manager.createForIssue("ABC-1");
      expect(first.createdNow).toBe(true);
      expect((await stat(first.path)).isDirectory()).toBe(true);

      const second = await manager.createForIssue("ABC-1");
      expect(second.createdNow).toBe(false);
      expect(second.path).toBe(first.path);
    });
  });

  it("runs after_create only when the workspace is newly created", async () => {
    await withRoot(async (root) => {
      const marker = path.join(root, "marker.txt");
      const config = buildServiceConfig(
        { workspace: { root }, hooks: { after_create: `echo created >> "${marker}"` } },
        root
      );
      const manager = new WorkspaceManager(config, logger);

      await manager.createForIssue("ABC-1");
      await manager.createForIssue("ABC-1");

      const content = await import("node:fs/promises").then((fs) => fs.readFile(marker, "utf8"));
      expect(content.trim().split("\n")).toEqual(["created"]);
    });
  });

  it("fails workspace creation and removes the new directory when after_create fails", async () => {
    await withRoot(async (root) => {
      const config = buildServiceConfig({ workspace: { root }, hooks: { after_create: "exit 1" } }, root);
      const manager = new WorkspaceManager(config, logger);

      await expect(manager.createForIssue("ABC-1")).rejects.toThrow(WorkspaceError);
      await expect(stat(path.join(root, "ABC-1"))).rejects.toThrow();
    });
  });

  it("propagates before_run failures without deleting the workspace", async () => {
    await withRoot(async (root) => {
      const config = buildServiceConfig({ workspace: { root }, hooks: { before_run: "exit 1" } }, root);
      const manager = new WorkspaceManager(config, logger);

      const workspace = await manager.createForIssue("ABC-1");
      await expect(manager.runBeforeRun(workspace.path)).rejects.toThrow(WorkspaceError);
      expect((await stat(workspace.path)).isDirectory()).toBe(true);
    });
  });

  it("swallows after_run failures", async () => {
    await withRoot(async (root) => {
      const config = buildServiceConfig({ workspace: { root }, hooks: { after_run: "exit 1" } }, root);
      const manager = new WorkspaceManager(config, logger);
      const workspace = await manager.createForIssue("ABC-1");
      await expect(manager.runAfterRun(workspace.path)).resolves.toBeUndefined();
    });
  });

  it("removes the workspace directory and ignores before_remove failures", async () => {
    await withRoot(async (root) => {
      const config = buildServiceConfig({ workspace: { root }, hooks: { before_remove: "exit 1" } }, root);
      const manager = new WorkspaceManager(config, logger);
      const workspace = await manager.createForIssue("ABC-1");
      await writeFile(path.join(workspace.path, "file.txt"), "content");

      await expect(manager.remove("ABC-1")).resolves.toBeUndefined();
      await expect(stat(workspace.path)).rejects.toThrow();
    });
  });
});
