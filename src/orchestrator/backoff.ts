/** Retry and backoff formulas (SPEC.md 8.4). */

/** Short fixed delay for continuation retries after a clean worker exit. */
export const CONTINUATION_RETRY_DELAY_MS = 1000;

/** `delay = min(10000 * 2^(attempt - 1), maxRetryBackoffMs)`. */
export function failureBackoffMs(attempt: number, maxRetryBackoffMs: number): number {
  const delay = 10000 * 2 ** (attempt - 1);
  return Math.min(delay, maxRetryBackoffMs);
}

export function nextAttemptFrom(previousAttempt: number | null): number {
  return (previousAttempt ?? 0) + 1;
}
