/**
 * Stable error categories used across the service (SPEC.md 5.5, 11.4).
 */

export type WorkflowErrorCategory =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error";

export class WorkflowError extends Error {
  readonly category: WorkflowErrorCategory;

  constructor(category: WorkflowErrorCategory, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkflowError";
    this.category = category;
  }
}

export type ConfigErrorCategory = "invalid_config" | "invalid_tracker_config" | "missing_tracker_secret";

export class ConfigError extends Error {
  readonly category: ConfigErrorCategory;

  constructor(category: ConfigErrorCategory, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigError";
    this.category = category;
  }
}

export type TrackerErrorCategory =
  | "unsupported_tracker_kind"
  | "invalid_tracker_config"
  | "missing_tracker_secret"
  | "tracker_request"
  | "tracker_status"
  | "tracker_response"
  | "tracker_pagination"
  | "tracker_rate_limited";

export class TrackerError extends Error {
  readonly category: TrackerErrorCategory;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    category: TrackerErrorCategory,
    message: string,
    options?: { cause?: unknown; retryable?: boolean; retryAfterMs?: number }
  ) {
    super(message, { cause: options?.cause });
    this.name = "TrackerError";
    this.category = category;
    this.retryable = options?.retryable ?? false;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export type WorkspaceErrorCategory =
  | "workspace_outside_root"
  | "workspace_create_failed"
  | "hook_failed"
  | "hook_timeout";

export class WorkspaceError extends Error {
  readonly category: WorkspaceErrorCategory;

  constructor(category: WorkspaceErrorCategory, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceError";
    this.category = category;
  }
}

export type AgentErrorCategory =
  | "codex_not_found"
  | "invalid_workspace_cwd"
  | "response_timeout"
  | "turn_timeout"
  | "port_exit"
  | "response_error"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required";

export class AgentError extends Error {
  readonly category: AgentErrorCategory;

  constructor(category: AgentErrorCategory, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentError";
    this.category = category;
  }
}

/** A generic Result type used at adapter boundaries per SPEC.md 11.1. */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
