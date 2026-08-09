import chalk from "chalk";
import type { QueueFile } from "../../queue.js";

export function renderStatusBar(
  queue: QueueFile,
  gitBranch: string | null,
): string {
  const paused = queue.paused
    ? chalk.yellow("[PAUSED]")
    : chalk.green("running");
  const active = queue.entries.filter((e) => e.status === "running").length;
  const branch = gitBranch ? ` · ${gitBranch}` : "";
  return `CBX Orchestrator TUI · queue=${paused} · active=${active}/${queue.maxConcurrent}${branch}`;
}
