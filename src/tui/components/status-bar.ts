import chalk from "chalk";
import type { QueueFile } from "../../queue.js";

export interface ArmedHint {
  action: "forget" | "purge";
  jobId: string;
}

export function renderStatusBar(
  queue: QueueFile,
  gitBranch: string | null,
  armed?: ArmedHint | null,
): string {
  const paused = queue.paused
    ? chalk.yellow("[PAUSED]")
    : chalk.green("running");
  const active = queue.entries.filter((e) => e.status === "running").length;
  const branch = gitBranch ? ` · ${gitBranch}` : "";
  let hint = "";
  if (armed) {
    // forget/purge 是不可逆操作：第一次按键进入 armed 后，状态栏提示用户再按一次同键确认。
    // 键位：forget → d（小写），purge → D（Shift+d），与 keyboard.ts 一致。
    const key = armed.action === "purge" ? "D" : "d";
    hint = ` · ${chalk.yellow(`⚠ 再按 ${key} 确认 ${armed.action} ${armed.jobId}（3s）`)}`;
  }
  return `CBX Orchestrator TUI · queue=${paused} · active=${active}/${queue.maxConcurrent}${branch}${hint}`;
}
