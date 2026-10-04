import { err, ok, TrackerError, type Result } from "../domain/errors.js";
import { resolveVarIndirection } from "../config/resolve.js";

/**
 * Transport and secret helpers shared by the GraphQL-backed tracker adapters (Linear, GitHub).
 * Only the request/response/error-mapping mechanics live here; each adapter owns its queries,
 * normalization, and scope rules.
 */

/**
 * Resolve a secret from `tracker.provider` (supports `$VAR` indirection), falling back to
 * `envFallback`. Empty resolution is treated as missing (SPEC.md 5.3.1).
 */
export function resolveSecret(raw: unknown, envFallback: string): string | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) {
    const resolved = resolveVarIndirection(raw);
    return resolved && resolved.length > 0 ? resolved : undefined;
  }
  const fromEnv = process.env[envFallback];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export interface GraphqlRequest {
  /** Human-readable provider name used in error messages, e.g. `"Linear"`. */
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * POST a GraphQL document and map every failure mode onto a {@link TrackerError}:
 * - network failure → `tracker_request` (retryable)
 * - HTTP 429, or HTTP 403 carrying `retry-after` or `x-ratelimit-remaining: 0` (GitHub primary
 *   and secondary limits) → `tracker_rate_limited` (retryable, honors `retry-after`)
 * - other non-2xx → `tracker_status` (retryable for 5xx)
 * - invalid JSON, GraphQL `errors`, missing `data` → `tracker_response`; a GraphQL error with
 *   `type: "RATE_LIMITED"` (GitHub) → `tracker_rate_limited`
 */
export async function postGraphql<T>(request: GraphqlRequest): Promise<Result<T, TrackerError>> {
  const { provider } = request;
  let response: Response;
  try {
    response = await fetch(request.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...request.headers },
      body: JSON.stringify({ query: request.query, variables: request.variables })
    });
  } catch (cause) {
    return err(new TrackerError("tracker_request", `${provider} request failed: ${String(cause)}`, { cause, retryable: true }));
  }

  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("retry-after") !== null || response.headers.get("x-ratelimit-remaining") === "0"));
  if (rateLimited) {
    return err(
      new TrackerError("tracker_rate_limited", `${provider} API rate limit exceeded`, {
        retryable: true,
        retryAfterMs: retryAfterMs(response)
      })
    );
  }

  if (!response.ok) {
    return err(new TrackerError("tracker_status", `${provider} API returned HTTP ${response.status}`, { retryable: response.status >= 500 }));
  }

  let body: { data?: T | null; errors?: { message: string; type?: string }[] };
  try {
    body = (await response.json()) as typeof body;
  } catch (cause) {
    return err(new TrackerError("tracker_response", `${provider} API returned invalid JSON`, { cause }));
  }

  if (body.errors && body.errors.length > 0) {
    const graphqlRateLimited = body.errors.some((e) => e.type === "RATE_LIMITED");
    return err(
      new TrackerError(
        graphqlRateLimited ? "tracker_rate_limited" : "tracker_response",
        `${provider} API error: ${body.errors.map((e) => e.message).join("; ")}`,
        { retryable: graphqlRateLimited }
      )
    );
  }
  if (body.data === undefined || body.data === null) {
    return err(new TrackerError("tracker_response", `${provider} API response missing 'data'`));
  }

  return ok(body.data);
}
