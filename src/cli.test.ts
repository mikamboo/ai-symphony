import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "cli.ts");
const repoRoot = path.resolve(here, "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

interface RunResult {
  code: number | null;
  stderr: string;
}

function runCli(args: string[], cwd: string, signalAfterMs?: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliPath, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));

    if (signalAfterMs) {
      setTimeout(() => child.kill("SIGINT"), signalAfterMs);
    }
  });
}

describe("symphony CLI lifecycle", () => {
  it("exits nonzero when the explicit workflow path does not exist", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "symphony-cli-"));
    try {
      const result = await runCli(["/nonexistent/WORKFLOW.md"], cwd);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("startup.workflow_load_failed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20000);

  it("exits nonzero when no WORKFLOW.md exists in the cwd default", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "symphony-cli-"));
    try {
      const result = await runCli([], cwd);
      expect(result.code).not.toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20000);

  it("starts successfully with a valid mock-tracker WORKFLOW.md and exits 0 on SIGINT", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "symphony-cli-"));
    try {
      await writeFile(
        path.join(cwd, "WORKFLOW.md"),
        [
          "---",
          "tracker:",
          "  kind: mock",
          "  active_states: [Todo]",
          "  terminal_states: [Done]",
          "polling:",
          "  interval_ms: 60000",
          "---",
          "",
          "Do the thing."
        ].join("\n")
      );

      const result = await runCli([], cwd, 1000);
      expect(result.code).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20000);
});
