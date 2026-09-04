import { err, TrackerError, type Result } from "../domain/errors.js";
import type { ServiceConfig } from "../domain/types.js";
import type { Logger } from "../logging/logger.js";
import type { TrackerAdapter, TrackerAdapterFactory } from "./adapter.js";
import { LinearTrackerAdapter } from "./linear.js";
import { MockTrackerAdapter } from "./mock.js";

const factories: Record<string, TrackerAdapterFactory> = {
  linear: (config, logger) => LinearTrackerAdapter.create(config, logger),
  mock: () => ({ ok: true, value: new MockTrackerAdapter() })
};

export function registerTrackerAdapter(kind: string, factory: TrackerAdapterFactory): void {
  factories[kind] = factory;
}

export function buildTrackerAdapter(config: ServiceConfig, logger: Logger): Result<TrackerAdapter, TrackerError> {
  const factory = factories[config.tracker.kind];
  if (!factory) {
    return err(new TrackerError("unsupported_tracker_kind", `Unsupported tracker.kind: '${config.tracker.kind}'`));
  }
  return factory(config, logger);
}
