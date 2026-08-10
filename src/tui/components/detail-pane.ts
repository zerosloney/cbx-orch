import chalk from "chalk";
import type { JobState, StageReport } from "../../types.js";
import { colorizeStatus } from "../theme.js";
import type { JobTimeline } from "../../ui.js";

function colorizeVerdict(verdict: string | null | undefined): string {
  if (verdict === "PASS") return chalk.green(verdict);
  if (verdict === "FAIL") return chalk.red(verdict);
  return chalk.gray(verdict ?? "skip");
}

export function renderDetailPane(
  state: JobState | undefined,
  timeline: JobTimeline | null = null,
  stages: StageReport[] | null = null,
): string {
  if (!state) return chalk.gray("按 ↑/↓ 选择任务查看详情");
  const lines: string[] = [];
  lines.push(`${chalk.bold("Job:")}    ${state.jobId}`);
  lines.push(`${chalk.bold("Status:")}  ${colorizeStatus(state.status)}`);
  lines.push(`${chalk.bold("Phase:")}   ${state.phase ?? "—"}`);
  lines.push(`${chalk.bold("Attempt:")} ${state.attempt ?? 0}`);
  // stage 链：单行内联 name / executor / verdict（PASS 绿 / FAIL 红 / skip 灰）。
  if (stages && stages.length > 0) {
    const chain = stages
      .map(
        (s) =>
          `${s.name} / ${s.executor} / ${colorizeVerdict(s.reviewVerdict ?? (s.exitCode === 0 ? "PASS" : "FAIL"))}`,
      )
      .join(" → ");
    lines.push(`${chalk.bold("Stages:")}  ${chain}`);
  }
  // 阶段时间线摘要：当前阶段 + 已跑秒数。
  if (timeline && timeline.stages.length > 0) {
    lines.push(
      `${chalk.bold("Current:")} ${timeline.currentStage ?? "—"} · ${timeline.elapsedSec}s`,
    );
  }
  const error = (state as Record<string, unknown>).error;
  if (typeof error === "string")
    lines.push(`${chalk.bold("Error:")}   ${chalk.red(error)}`);
  return lines.join("\n");
}
