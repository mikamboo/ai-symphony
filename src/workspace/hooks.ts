import { spawn } from "node:child_process";
import { WorkspaceError } from "../domain/errors.js";
import type { Logger } from "../logging/logger.js";

export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

const MAX_LOGGED_OUTPUT_CHARS = 4000;

function truncate(s: string): string {
  return s.length > MAX_LOGGED_OUTPUT_CHARS ? `${s.slice(0, MAX_LOGGED_OUTPUT_CHARS)}...<truncated>` : s;
}

/**
 * Run a workspace lifecycle hook (SPEC.md 9.4): `sh -lc <script>` (POSIX default: `bash -lc`)
 * with the workspace directory as `cwd`, bounded by `hooks.timeout_ms`.
 */
export async function runHook(
  hookName: HookName,
  script: string,
  cwd: string,
  timeoutMs: number,
  logger: Logger
): Promise<void> {
  logger.info("hook.start", { hook: hookName, cwd });

  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", script], { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (cause) => {
      clearTimeout(timer);
      logger.error("hook.failed", { hook: hookName, error: String(cause) });
      reject(new WorkspaceError("hook_failed", `Hook '${hookName}' failed to start: ${String(cause)}`, { cause }));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        logger.error("hook.timeout", { hook: hookName, timeout_ms: timeoutMs });
        reject(new WorkspaceError("hook_timeout", `Hook '${hookName}' timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        logger.error("hook.failed", {
          hook: hookName,
          exit_code: code,
          stdout: truncate(stdout),
          stderr: truncate(stderr)
        });
        reject(new WorkspaceError("hook_failed", `Hook '${hookName}' exited with code ${code}`));
        return;
      }
      logger.info("hook.completed", { hook: hookName, stdout: truncate(stdout) });
      resolve();
    });
  });
}

/** Run a hook but only log failures instead of propagating them (SPEC.md 9.4: after_run / before_remove). */
export async function runHookBestEffort(
  hookName: HookName,
  script: string | null,
  cwd: string,
  timeoutMs: number,
  logger: Logger
): Promise<void> {
  if (!script) return;
  try {
    await runHook(hookName, script, cwd, timeoutMs, logger);
  } catch (cause) {
    logger.warn("hook.ignored_failure", { hook: hookName, error: String(cause) });
  }
}
