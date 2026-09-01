import { issueRoutable } from "../tracker/adapter.js";
import { normalizeState, type Issue, type OrchestratorState, type ServiceConfig } from "../domain/types.js";

function inPriorityBucket(priority: number | null): boolean {
  return priority !== null && priority >= 1 && priority <= 4;
}

/**
 * Dispatch sort order (SPEC.md 8.2): priority `1..4` ascending first (everything else sorts
 * after), then `created_at` oldest-first (null last), then `identifier` lexicographically.
 */
export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const aBucketed = inPriorityBucket(a.priority);
    const bBucketed = inPriorityBucket(b.priority);
    if (aBucketed && bBucketed) {
      const diff = (a.priority as number) - (b.priority as number);
      if (diff !== 0) return diff;
    } else if (aBucketed !== bBucketed) {
      return aBucketed ? -1 : 1;
    }

    const aCreated = a.createdAt ? Date.parse(a.createdAt) : Number.POSITIVE_INFINITY;
    const bCreated = b.createdAt ? Date.parse(b.createdAt) : Number.POSITIVE_INFINITY;
    if (aCreated !== bCreated) return aCreated - bCreated;

    return a.identifier.localeCompare(b.identifier);
  });
}

export function availableGlobalSlots(state: OrchestratorState, config: ServiceConfig): number {
  return Math.max(config.agent.maxConcurrentAgents - state.running.size, 0);
}

export function noAvailableSlots(state: OrchestratorState, config: ServiceConfig): boolean {
  return availableGlobalSlots(state, config) <= 0;
}

function countRunningInState(state: OrchestratorState, normalizedStateName: string): number {
  let count = 0;
  for (const entry of state.running.values()) {
    if (normalizeState(entry.issue.state) === normalizedStateName) count += 1;
  }
  return count;
}

/** Per-state concurrency limit, falling back to the global limit (SPEC.md 8.3). */
export function availableStateSlots(state: OrchestratorState, config: ServiceConfig, normalizedStateName: string): number {
  const limit = config.agent.maxConcurrentAgentsByState[normalizedStateName] ?? config.agent.maxConcurrentAgents;
  return Math.max(limit - countRunningInState(state, normalizedStateName), 0);
}

export function isActiveState(config: ServiceConfig, state: string): boolean {
  const normalized = normalizeState(state);
  return config.tracker.activeStates.some((s) => normalizeState(s) === normalized);
}

export function isTerminalState(config: ServiceConfig, state: string): boolean {
  const normalized = normalizeState(state);
  return config.tracker.terminalStates.some((s) => normalizeState(s) === normalized);
}

/** Full dispatch eligibility check (SPEC.md 8.2), excluding the global-slot check (checked by the tick loop). */
export function shouldDispatch(issue: Issue, state: OrchestratorState, config: ServiceConfig): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
  if (!isActiveState(config, issue.state) || isTerminalState(config, issue.state)) return false;
  if (!issueRoutable(issue, config.tracker.requiredLabels)) return false;
  if (state.running.has(issue.id)) return false;
  if (state.claimed.has(issue.id)) return false;
  if (availableStateSlots(state, config, normalizeState(issue.state)) <= 0) return false;
  return true;
}
