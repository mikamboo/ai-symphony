import os from "node:os";
import path from "node:path";
import { ConfigError } from "../domain/errors.js";
import type {
  AgentConfig,
  CodexConfig,
  HooksConfig,
  PollingConfig,
  ServiceConfig,
  TrackerConfig,
  WorkspaceConfig
} from "../domain/types.js";

const VAR_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Resolve `$VAR_NAME` indirection. Per SPEC.md 6.1 this only applies to values that *explicitly*
 * contain `$VAR_NAME` (the whole string is the reference); it is not a global env override.
 * Per SPEC.md 5.3.1, a documented secret that resolves to an empty string is treated as missing
 * (returns undefined).
 */
export function resolveVarIndirection(value: string): string | undefined {
  const match = VAR_PATTERN.exec(value.trim());
  if (!match) return value;
  const varName = match[1] as string;
  const resolved = process.env[varName];
  if (resolved === undefined || resolved === "") return undefined;
  return resolved;
}

/** Expand `~` and `$VAR` indirection for values intended to be local filesystem paths. */
export function expandPathValue(value: string): string {
  let expanded = value;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  const varResolved = resolveVarIndirection(expanded);
  return varResolved ?? expanded;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("invalid_config", `Expected an object, got ${Array.isArray(value) ? "array" : typeof value}`);
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ConfigError("invalid_config", `${field} must be a list of strings`);
  return value.map((entry, i) => {
    if (typeof entry !== "string") throw new ConfigError("invalid_config", `${field}[${i}] must be a string`);
    return entry;
  });
}

function asPositiveInt(value: unknown, field: string, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError("invalid_config", `${field} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

function asInt(value: unknown, field: string, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ConfigError("invalid_config", `${field} must be an integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

function asStringOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ConfigError("invalid_config", `${field} must be a string`);
  return value;
}

function buildTrackerConfig(raw: Record<string, unknown>): TrackerConfig {
  const kind = raw.kind;
  if (kind !== undefined && typeof kind !== "string") {
    throw new ConfigError("invalid_tracker_config", "tracker.kind must be a string");
  }
  return {
    kind: (kind as string | undefined) ?? "",
    provider: asRecord(raw.provider),
    requiredLabels: asStringArray(raw.required_labels, "tracker.required_labels").map((l) => l.trim().toLowerCase()),
    activeStates: asStringArray(raw.active_states, "tracker.active_states"),
    terminalStates: asStringArray(raw.terminal_states, "tracker.terminal_states")
  };
}

function buildPollingConfig(raw: Record<string, unknown>): PollingConfig {
  return { intervalMs: asPositiveInt(raw.interval_ms, "polling.interval_ms", 30000) };
}

function buildWorkspaceConfig(raw: Record<string, unknown>, workflowDir: string): WorkspaceConfig {
  const rootRaw = typeof raw.root === "string" ? raw.root : path.join(os.tmpdir(), "symphony_workspaces");
  const expanded = expandPathValue(rootRaw);
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(workflowDir, expanded);
  return { root: absolute };
}

function buildHooksConfig(raw: Record<string, unknown>): HooksConfig {
  return {
    afterCreate: asStringOrNull(raw.after_create, "hooks.after_create"),
    beforeRun: asStringOrNull(raw.before_run, "hooks.before_run"),
    afterRun: asStringOrNull(raw.after_run, "hooks.after_run"),
    beforeRemove: asStringOrNull(raw.before_remove, "hooks.before_remove"),
    timeoutMs: asPositiveInt(raw.timeout_ms, "hooks.timeout_ms", 60000)
  };
}

function buildAgentConfig(raw: Record<string, unknown>): AgentConfig {
  const byStateRaw = asRecord(raw.max_concurrent_agents_by_state);
  const byState: Record<string, number> = {};
  for (const [stateName, v] of Object.entries(byStateRaw)) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
      byState[stateName.trim().toLowerCase()] = n;
    }
    // Invalid entries (non-positive or non-numeric) are ignored per SPEC.md 5.3.5.
  }
  return {
    maxConcurrentAgents: asPositiveInt(raw.max_concurrent_agents, "agent.max_concurrent_agents", 10),
    maxTurns: asPositiveInt(raw.max_turns, "agent.max_turns", 20),
    maxRetryBackoffMs: asPositiveInt(raw.max_retry_backoff_ms, "agent.max_retry_backoff_ms", 300000),
    maxConcurrentAgentsByState: byState
  };
}

function buildCodexConfig(raw: Record<string, unknown>): CodexConfig {
  const command = raw.command === undefined ? "codex app-server" : raw.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new ConfigError("invalid_config", "codex.command must be a non-empty string");
  }
  return {
    command,
    approvalPolicy: asStringOrNull(raw.approval_policy, "codex.approval_policy"),
    threadSandbox: asStringOrNull(raw.thread_sandbox, "codex.thread_sandbox"),
    turnSandboxPolicy: asStringOrNull(raw.turn_sandbox_policy, "codex.turn_sandbox_policy"),
    turnTimeoutMs: asPositiveInt(raw.turn_timeout_ms, "codex.turn_timeout_ms", 3600000),
    readTimeoutMs: asPositiveInt(raw.read_timeout_ms, "codex.read_timeout_ms", 5000),
    stallTimeoutMs: asInt(raw.stall_timeout_ms, "codex.stall_timeout_ms", 300000)
  };
}

/**
 * Build the typed {@link ServiceConfig} view from raw WORKFLOW.md front matter (SPEC.md 6.1, 6.4).
 * Throws {@link ConfigError} on any invalid value.
 */
export function buildServiceConfig(rawConfig: Record<string, unknown>, workflowDir: string): ServiceConfig {
  return {
    tracker: buildTrackerConfig(asRecord(rawConfig.tracker)),
    polling: buildPollingConfig(asRecord(rawConfig.polling)),
    workspace: buildWorkspaceConfig(asRecord(rawConfig.workspace), workflowDir),
    hooks: buildHooksConfig(asRecord(rawConfig.hooks)),
    agent: buildAgentConfig(asRecord(rawConfig.agent)),
    codex: buildCodexConfig(asRecord(rawConfig.codex)),
    workflowDir
  };
}
