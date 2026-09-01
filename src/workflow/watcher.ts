import chokidar, { type FSWatcher } from "chokidar";

export interface WorkflowWatchHandle {
  close(): Promise<void>;
}

/**
 * Watches the resolved WORKFLOW.md path and invokes `onChange` (debounced) whenever it is
 * added/changed. Dynamic reload is REQUIRED by SPEC.md 6.2; this is the filesystem-watch half of
 * that requirement. Reload failure handling (keep last-known-good config) is the caller's
 * responsibility (see `config/reload.ts`).
 */
export function watchWorkflowFile(filePath: string, onChange: () => void, debounceMs = 150): WorkflowWatchHandle {
  const watcher: FSWatcher = chokidar.watch(filePath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: debounceMs, pollInterval: 25 }
  });

  watcher.on("add", onChange);
  watcher.on("change", onChange);

  return {
    async close() {
      await watcher.close();
    }
  };
}
