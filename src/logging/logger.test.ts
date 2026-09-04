import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("includes issue_id/issue_identifier/session_id context fields", () => {
    const logger = createLogger();
    logger.info("worker.started", { issue_id: "id-1", issue_identifier: "ENG-1", session_id: "s-1" });

    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("issue_id=id-1");
    expect(line).toContain("issue_identifier=ENG-1");
    expect(line).toContain("session_id=s-1");
    expect(line).toContain("msg=worker.started");
  });

  it("redacts secret-shaped field names", () => {
    const logger = createLogger();
    logger.info("tracker.configured", { api_key: "super-secret", token: "also-secret", auth_token: "also-secret-2" });

    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("super-secret");
    expect(line).not.toContain("also-secret");
    expect(line).toContain("api_key=[redacted]");
    expect(line).toContain("token=[redacted]");
    expect(line).toContain("auth_token=[redacted]");
  });

  it("does not redact token-count observability fields (SPEC.md 13.5)", () => {
    const logger = createLogger();
    logger.info("snapshot", { total_tokens: 4200, codex_input_tokens: 1000, codex_output_tokens: 3200 });

    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("total_tokens=4200");
    expect(line).toContain("codex_input_tokens=1000");
    expect(line).toContain("codex_output_tokens=3200");
  });

  it("routes warn/error to console.error and info/debug to console.log", () => {
    const logger = createLogger();
    logger.info("a", {});
    logger.warn("b", {});
    logger.error("c", {});
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("child() merges base context into every subsequent log line", () => {
    const logger = createLogger().child({ issue_id: "id-9" });
    logger.info("worker.step", {});
    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("issue_id=id-9");
  });
});
