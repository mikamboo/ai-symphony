import crypto from "node:crypto";

const ALLOWED_CHARS = /[^A-Za-z0-9._-]/g;

/**
 * Derive a sanitized, collision-resistant workspace key from an issue identifier
 * (SPEC.md 4.2, 9.2, 15.2 invariant 3).
 *
 * Only `[A-Za-z0-9._-]` is allowed in workspace directory names; every other character is
 * replaced with `_`. If sanitization changed the identifier, a stable hash suffix of the
 * *original* identifier (>=64 bits of entropy, hex-encoded so it only uses allowed characters)
 * is appended so that distinct identifiers which sanitize to the same text stay
 * collision-resistant.
 */
export function deriveWorkspaceKey(identifier: string): string {
  const sanitized = identifier.replace(ALLOWED_CHARS, "_");
  if (sanitized === identifier) return sanitized;
  const hash = crypto.createHash("sha256").update(identifier, "utf8").digest("hex").slice(0, 16); // 64 bits
  return `${sanitized}_${hash}`;
}
