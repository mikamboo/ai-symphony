import { promises as fs } from "node:fs";
import path from "node:path";
import { WorkspaceError } from "../domain/errors.js";
import type { ServiceConfig, Workspace } from "../domain/types.js";
import type { Logger } from "../logging/logger.js";
import { deriveWorkspaceKey } from "./key.js";
import { runHook, runHookBestEffort } from "./hooks.js";

/**
 * Safety invariant 2 (SPEC.md 9.5 / 15.2): the workspace path MUST stay inside the workspace root.
 * Both paths are normalized to absolute; `root` must be a prefix directory of `candidate`.
 */
export function assertWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  const escapesRoot = relative === "" || relative.startsWith("..") || path.isAbsolute(relative);
  if (escapesRoot) {
    throw new WorkspaceError("workspace_outside_root", `Workspace path ${candidate} is not inside workspace root ${root}`);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export class WorkspaceManager {
  constructor(
    private readonly config: ServiceConfig,
    private readonly logger: Logger
  ) {}

  /** Compute the workspace path for an issue identifier without touching the filesystem. */
  pathForIdentifier(identifier: string): { workspaceKey: string; workspacePath: string } {
    const workspaceKey = deriveWorkspaceKey(identifier);
    const workspacePath = path.join(this.config.workspace.root, workspaceKey);
    assertWithinRoot(this.config.workspace.root, workspacePath);
    return { workspaceKey, workspacePath };
  }

  /**
   * Create or reuse the workspace for an issue (SPEC.md 9.2). Runs `after_create` only when the
   * directory did not already exist; a hook failure is fatal and the partially created directory
   * is removed.
   */
  async createForIssue(identifier: string): Promise<Workspace> {
    const { workspaceKey, workspacePath } = this.pathForIdentifier(identifier);
    const existedBefore = await pathExists(workspacePath);

    if (!existedBefore) {
      try {
        await fs.mkdir(workspacePath, { recursive: true });
      } catch (cause) {
        throw new WorkspaceError("workspace_create_failed", `Failed to create workspace at ${workspacePath}`, { cause });
      }
    }

    const createdNow = !existedBefore;

    if (createdNow && this.config.hooks.afterCreate) {
      try {
        await runHook("after_create", this.config.hooks.afterCreate, workspacePath, this.config.hooks.timeoutMs, this.logger);
      } catch (cause) {
        // after_create failure is fatal to workspace creation (SPEC.md 9.4); remove the
        // partially prepared directory since it was brand new (SPEC.md 9.3).
        await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
        throw cause;
      }
    }

    return { path: workspacePath, workspaceKey, createdNow };
  }

  /** Run `before_run` (fatal on failure) ahead of launching the coding agent. */
  async runBeforeRun(workspacePath: string): Promise<void> {
    assertWithinRoot(this.config.workspace.root, workspacePath);
    if (!this.config.hooks.beforeRun) return;
    await runHook("before_run", this.config.hooks.beforeRun, workspacePath, this.config.hooks.timeoutMs, this.logger);
  }

  /** Run `after_run` best-effort (logged, never throws) after every attempt. */
  async runAfterRun(workspacePath: string): Promise<void> {
    await runHookBestEffort("after_run", this.config.hooks.afterRun, workspacePath, this.config.hooks.timeoutMs, this.logger);
  }

  /** Remove a workspace directory for a terminal issue (SPEC.md 8.6, 8.5). */
  async remove(identifier: string): Promise<void> {
    const { workspacePath } = this.pathForIdentifier(identifier);
    if (!(await pathExists(workspacePath))) return;

    await runHookBestEffort("before_remove", this.config.hooks.beforeRemove, workspacePath, this.config.hooks.timeoutMs, this.logger);

    await fs.rm(workspacePath, { recursive: true, force: true });
    this.logger.info("workspace.removed", { workspace_path: workspacePath });
  }
}
