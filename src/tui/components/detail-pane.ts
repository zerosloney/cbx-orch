import chalk from "chalk";
import type { JobState } from "../../types.js";
import { colorizeStatus } from "../theme.js";

export function renderDetailPane(state: JobState | undefined): string {
  if (!state) return chalk.gray("按 ↑/↓ 选择任务查看详情");
  const lines: string[] = [];
  lines.push(`${chalk.bold("Job:")}    ${state.jobId}`);
  lines.push(`${chalk.bold("Status:")}  ${colorizeStatus(state.status)}`);
  lines.push(`${chalk.bold("Phase:")}   ${state.phase ?? "—"}`);
  lines.push(`${chalk.bold("Attempt:")} ${state.attempt ?? 0}`);
  const error = (state as Record<string, unknown>).error;
  if (typeof error === "string")
    lines.push(`${chalk.bold("Error:")}   ${chalk.red(error)}`);
  return lines.join("\n");
}
