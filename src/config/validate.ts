import { ConfigError, ok, err, type Result } from "../domain/errors.js";
import type { ServiceConfig } from "../domain/types.js";

export interface DispatchPreflightDeps {
  /** Throws or returns false if `tracker.kind` + `tracker.provider` cannot construct an adapter. */
  isTrackerConfigValid(config: ServiceConfig): { ok: true } | { ok: false; message: string };
}

/**
 * Dispatch preflight validation (SPEC.md 6.3): re-validated before every dispatch tick, not a
 * full audit of all workflow behavior.
 */
export function validateDispatchPreflight(config: ServiceConfig, deps: DispatchPreflightDeps): Result<true, ConfigError> {
  if (!config.tracker.kind) {
    return err(new ConfigError("invalid_tracker_config", "tracker.kind is required for dispatch"));
  }

  if (!config.codex.command || config.codex.command.trim().length === 0) {
    return err(new ConfigError("invalid_config", "codex.command is required for dispatch"));
  }

  const trackerCheck = deps.isTrackerConfigValid(config);
  if (!trackerCheck.ok) {
    return err(new ConfigError("invalid_tracker_config", trackerCheck.message));
  }

  return ok(true);
}
