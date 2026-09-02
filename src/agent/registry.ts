import type { AgentRunner } from "./runner.js";
import { SubprocessAgentRunner } from "./subprocessRunner.js";
import { ClaudeCodeAgentRunner } from "./claudeCodeRunner.js";

/**
 * Agent-runner selection is deliberately NOT part of `ServiceConfig`/SPEC.md's `codex.*` schema —
 * SPEC.md treats the coding agent as a deploy-time integration choice (SPEC.md Section 10.7:
 * "implement AgentRunner ... for your coding agent"), not a declarative config value. This is a
 * CLI-only convenience on top of that: an `agent_runner.kind` WORKFLOW.md front-matter extension
 * (SPEC.md 5.3 "front matter is extensible... extensions MAY define additional top-level keys")
 * so `pnpm run dev` can switch runners without a code change. It reads the raw parsed front
 * matter directly rather than going through `buildServiceConfig`, keeping the core config layer
 * spec-shaped and untouched.
 */
export type AgentRunnerKind = "subprocess" | "claude_code";

const DEFAULT_KIND: AgentRunnerKind = "subprocess";

export function parseAgentRunnerKind(rawConfig: Record<string, unknown>): AgentRunnerKind {
  const section = rawConfig.agent_runner;
  if (section === null || typeof section !== "object" || Array.isArray(section)) return DEFAULT_KIND;
  const kind = (section as Record<string, unknown>).kind;
  return kind === "claude_code" ? "claude_code" : DEFAULT_KIND;
}

export interface BuildAgentRunnerOptions {
  secretEnvNames: string[];
}

export function buildAgentRunner(kind: AgentRunnerKind, options: BuildAgentRunnerOptions): AgentRunner {
  switch (kind) {
    case "claude_code":
      return new ClaudeCodeAgentRunner({ secretEnvNames: options.secretEnvNames });
    case "subprocess":
    default:
      return new SubprocessAgentRunner({ secretEnvNames: options.secretEnvNames });
  }
}
