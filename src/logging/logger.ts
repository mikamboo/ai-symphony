/**
 * Structured logging (SPEC.md 13.1, 13.2, 15.3).
 *
 * - Uses stable `key=value` phrasing.
 * - Issue-related logs carry `issue_id` / `issue_identifier`; agent session logs carry `session_id`.
 * - Never logs secret values; callers must pre-redact anything sensitive before passing it in.
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(context: LogFields): Logger;
}

const SECRET_WORDS = new Set(["token", "secret", "password", "apikey", "credential", "credentials"]);

/**
 * Matches key names that look credential-shaped (`token`, `api_key`, `auth_token`, ...) without
 * flagging unrelated fields that merely contain those letters as part of a longer word, most
 * notably token *count* observability fields like `total_tokens` / `codex_input_tokens`
 * (SPEC.md 13.5 requires these to be logged, not redacted).
 */
function isSecretKey(key: string): boolean {
  const parts = key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.some((p) => SECRET_WORDS.has(p))) return true;
  return parts.some((p, i) => p === "api" && parts[i + 1] === "key");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") {
    return /[\s="]/.test(value) ? JSON.stringify(value) : value;
  }
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = isSecretKey(key) ? "[redacted]" : value;
  }
  return out;
}

type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, message: string, fields: LogFields, sink: (line: string) => void): void {
  const safeFields = redact(fields);
  const ts = new Date().toISOString();
  const parts = [`ts=${ts}`, `level=${level}`, `msg=${formatValue(message)}`];
  for (const [key, value] of Object.entries(safeFields)) {
    parts.push(`${key}=${formatValue(value)}`);
  }
  sink(parts.join(" "));
}

export function createLogger(baseContext: LogFields = {}): Logger {
  const emit = (level: Level, message: string, fields: LogFields = {}) => {
    const merged = { ...baseContext, ...fields };
    const sink = level === "error" || level === "warn" ? console.error : console.log;
    write(level, message, merged, (line) => sink(line));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (context: LogFields) => createLogger({ ...baseContext, ...context })
  };
}

export const rootLogger: Logger = createLogger();
