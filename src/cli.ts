#!/usr/bin/env node
import path from "node:path";
import { loadWorkflowFile, resolveWorkflowPath } from "./workflow/loader.js";
import { buildServiceConfig } from "./config/resolve.js";
import { buildTrackerAdapter } from "./tracker/registry.js";
import { buildAgentRunner, parseAgentRunnerKind } from "./agent/registry.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createLogger } from "./logging/logger.js";

/** Accepts `symphony [path-to-WORKFLOW.md]` and, equivalently, `--workflow <path>` / `-w <path>` (SPEC.md 17.7). */
function parseArgs(argv: string[]): { workflowPath: string | null } {
  let workflowPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if ((arg === "--workflow" || arg === "-w") && argv[i + 1]) {
      workflowPath = argv[i + 1] as string;
      i++;
    } else if (!arg.startsWith("-") && workflowPath === null) {
      workflowPath = arg;
    }
  }
  return { workflowPath };
}

async function main(): Promise<void> {
  const logger = createLogger({ component: "symphony" });
  const { workflowPath: explicitPath } = parseArgs(process.argv.slice(2));
  const workflowPath = resolveWorkflowPath(explicitPath);

  const workflow = await loadWorkflowFile(workflowPath).catch((cause) => {
    logger.error("startup.workflow_load_failed", { error: String(cause), workflow_path: workflowPath });
    process.exit(1);
  });

  const config = (() => {
    try {
      return buildServiceConfig(workflow.config, path.dirname(workflowPath));
    } catch (cause) {
      logger.error("startup.config_invalid", { error: String(cause) });
      process.exit(1);
    }
  })();

  const trackerResult = buildTrackerAdapter(config, logger);
  if (!trackerResult.ok) {
    logger.error("startup.tracker_invalid", { error: trackerResult.error.message, category: trackerResult.error.category });
    process.exit(1);
  }
  const tracker = trackerResult.value;

  const agentRunnerKind = parseAgentRunnerKind(workflow.config);
  const agentRunner = buildAgentRunner(agentRunnerKind, { secretEnvNames: tracker.secretEnvironmentNames() });
  logger.info("startup.agent_runner_selected", { kind: agentRunnerKind });

  const orchestrator = new Orchestrator({
    workflowPath,
    workflow,
    config,
    tracker,
    agentRunner,
    logger,
    onSnapshot: (snapshot) => {
      logger.debug("snapshot", {
        running: snapshot.running.length,
        retrying: snapshot.retrying.length,
        total_tokens: snapshot.codexTotals.totalTokens
      });
    }
  });

  const shutdown = async (signal: string) => {
    logger.info("service.shutting_down", { signal });
    await orchestrator.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await orchestrator.start();
  } catch (cause) {
    logger.error("startup.failed", { error: String(cause) });
    process.exit(1);
  }
}

main().catch((cause) => {
  console.error("Fatal error during startup:", cause);
  process.exit(1);
});
