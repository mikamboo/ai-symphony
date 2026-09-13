#!/usr/bin/env bash
# Runs all four dev-workflow pipeline stages as background Symphony processes.
# Design: ../../docs/dev-workflow-pipeline.md.
#
# Usage (from the repo root, after `pnpm install && pnpm run build` or in dev mode):
#   export LINEAR_API_KEY=lin_api_...
#   export GITHUB_TOKEN=ghp_...          # used by dev/ and qa/ hooks only, never reaches an agent
#   export GITHUB_REPO=your-org/your-repo
#   ./pipelines/dev-workflow/run-all.sh
#
# Ctrl-C stops all four together. Each stage is an independent, lightweight daemon process --
# nothing here needs a process manager; docker-compose/pm2/systemd are reasonable production
# alternatives once this moves past local testing (see docs/dev-workflow-pipeline.md).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SYMPHONY_PIPELINE_ROOT="$SCRIPT_DIR"

for var in LINEAR_API_KEY GITHUB_TOKEN GITHUB_REPO; do
  if [ -z "${!var:-}" ]; then
    echo "run-all.sh: $var is not set -- see this script's header comment" >&2
    exit 1
  fi
done

cd "$SCRIPT_DIR/.."  # repo root, so `pnpm run dev` resolves normally

pids=()
stages=(pm architect dev qa)
for stage in "${stages[@]}"; do
  echo "starting $stage..."
  pnpm run dev -- "pipelines/dev-workflow/$stage/WORKFLOW.md" &
  pids+=("$!")
done

trap 'echo "stopping all stages..."; kill "${pids[@]}" 2>/dev/null || true' INT TERM

wait
