import chalk, { type ChalkInstance } from "chalk";
import type { JobState } from "./types.js";
import type { QueueFile } from "./queue.js";

const STATUS_COLORS: Record<string, ChalkInstance> = {
  done: chalk.green,
  failed: chalk.red,
  review_failed: chalk.red,
  needs_fix: chalk.red,
  running: chalk.yellow,
  awaiting_approval: chalk.yellow,
  queued: chalk.cyan,
  cancelled: chalk.gray,
};

export function colorizeStatus(status: string): string {
  const color = STATUS_COLORS[status] ?? chalk.white;
  return color(status);
}

export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.CBX_JSON);
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function displayWidth(s: string): number {
  return stripAnsi(s).length;
}

function padDisplayEnd(s: string, width: number): string {
  const len = displayWidth(s);
  if (len >= width) return s;
  return s + " ".repeat(width - len);
}

export function fmtElapsed(iso: string | undefined | null): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return Math.floor(ms / 1000) + "s";
  if (ms < 3600_000)
    return (
      Math.floor(ms / 60_000) + "m " + Math.floor((ms % 60_000) / 1000) + "s"
    );
  return (
    Math.floor(ms / 3600_000) +
    "h " +
    Math.floor((ms % 3600_000) / 60_000) +
    "m"
  );
}

export function fmtTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function colorizeReview(verdict: string): string {
  if (verdict === "PASS") return chalk.green(verdict);
  if (verdict === "FAIL") return chalk.red(verdict);
  return verdict;
}

export function renderJobsTable(jobs: JobState[]): string {
  if (jobs.length === 0) return chalk.gray("暂无任务");

  const headers = [
    "Job",
    "Status",
    "Phase",
    "Att",
    "Review",
    "Elapsed",
    "Updated",
  ];
  const rows = jobs.map((j) => {
    const terminal = [
      "done",
      "failed",
      "review_failed",
      "cancelled",
      "needs_fix",
    ].includes(j.status);
    const totalSeconds = (j as Record<string, unknown>).totalSeconds;
    const elapsed =
      terminal && typeof totalSeconds === "number"
        ? totalSeconds < 60
          ? `${totalSeconds}s`
          : `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
        : fmtElapsed(j.createdAt);
    const review = String(j.reviewVerdict ?? "—");
    return [
      j.jobId,
      colorizeStatus(j.status),
      j.phase ?? "",
      String(j.attempt ?? 0),
      colorizeReview(review),
      elapsed,
      fmtTime(j.updatedAt),
    ];
  });

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => displayWidth(String(r[i])))),
  );

  const termWidth = process.stdout.columns ?? 120;
  const otherWidth = widths.slice(1).reduce((a, b) => a + b + 2, 0);
  widths[0] = Math.min(widths[0], Math.max(20, termWidth - otherWidth - 2));

  const line = (cells: string[]) =>
    cells.map((c, i) => padDisplayEnd(String(c), widths[i])).join("  ");

  return [
    chalk.bold(line(headers)),
    widths.map((w) => "─".repeat(w)).join("──"),
    ...rows.map((r) => line(r)),
  ].join("\n");
}

export function renderQueueTable(queue: QueueFile): string {
  const header = `Queue: ${queue.paused ? chalk.yellow("PAUSED") : chalk.green("running")} · maxConcurrent=${queue.maxConcurrent}`;
  const entries = queue.entries ?? [];
  if (entries.length === 0) return `${header}\n${chalk.gray("队列为空")}`;

  const rows = entries.map((e) => [
    e.jobId,
    colorizeStatus(e.status),
    e.priority ? String(e.priority) : "",
    fmtElapsed(e.createdAt),
    e.error ? chalk.red(e.error.slice(0, 40)) : "",
  ]);

  const headers = ["Job", "Status", "Pri", "Created", "Error"];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => displayWidth(String(r[i])))),
  );

  const line = (cells: string[]) =>
    cells.map((c, i) => padDisplayEnd(String(c), widths[i])).join("  ");

  return [
    header,
    chalk.bold(line(headers)),
    widths.map((w) => "─".repeat(w)).join("──"),
    ...rows.map((r) => line(r)),
  ].join("\n");
}

export function renderJobDetail(state: JobState): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Job:")}     ${state.jobId}`);
  lines.push(`${chalk.bold("Status:")}   ${colorizeStatus(state.status)}`);
  lines.push(`${chalk.bold("Phase:")}    ${state.phase ?? "—"}`);
  lines.push(`${chalk.bold("Attempt:")}  ${state.attempt ?? 0}`);
  const review = String(state.reviewVerdict ?? "—");
  lines.push(`${chalk.bold("Review:")}   ${colorizeReview(review)}`);
  lines.push(`${chalk.bold("Created:")}  ${state.createdAt ?? "—"}`);
  lines.push(`${chalk.bold("Updated:")}  ${state.updatedAt ?? "—"}`);
  const error = state.error;
  if (typeof error === "string")
    lines.push(`${chalk.bold("Error:")}    ${chalk.red(error)}`);
  return lines.join("\n");
}

export function renderHealth(result: {
  status: string;
  metrics: Record<string, unknown>;
}): string {
  const m = result.metrics as Record<string, number>;
  const lines: string[] = [];
  lines.push(
    `${chalk.bold("Status:")} ${result.status === "ok" ? chalk.green("ok") : chalk.red(result.status)}`,
  );
  lines.push("");
  const items: [string, number | undefined][] = [
    ["Queue depth", m.queueDepth],
    ["Failed jobs", m.failedJobs],
    ["Retrying jobs", m.retryingJobs],
    ["Pending deliveries", m.pendingDeliveries],
    ["Delivery failures", m.deliveryFailures],
  ];
  for (const [label, value] of items) {
    const num = value ?? 0;
    const colored =
      (label === "Failed jobs" || label === "Delivery failures") && num > 0
        ? chalk.red(String(num))
        : chalk.cyan(String(num));
    lines.push(`  ${label.padEnd(20)} ${colored}`);
  }
  if (m.jobsByStatus && typeof m.jobsByStatus === "object") {
    lines.push("");
    lines.push(chalk.bold("Jobs by status:"));
    for (const [status, count] of Object.entries(
      m.jobsByStatus as Record<string, number>,
    )) {
      lines.push(
        `  ${padDisplayEnd(colorizeStatus(status), 20)} ${chalk.cyan(String(count))}`,
      );
    }
  }
  return lines.join("\n");
}

interface ExportResult {
  status?: string;
  phase?: string;
  stages?: Array<{
    name: string;
    executor: string;
    exitCode: number;
    reviewVerdict?: string | null;
  }>;
  acceptanceEvidence?: Array<{ criterion: string; status: string }>;
  error?: string | null;
  handback?: string;
  updatedAt?: string;
}

/** 截断长文本到指定行数（保留完整行）。 */
function truncateLines(text: string | undefined, maxLines: number): string {
  if (!text) return "";
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(0, maxLines).join("\n") + "\n…（已截断）";
}

export function renderExport(
  state: JobState,
  result: ExportResult | null,
  format: "text" | "markdown",
): string {
  if (format === "text") {
    const lines: string[] = [renderJobDetail(state)];
    if (result) {
      if (result.stages && result.stages.length) {
        lines.push("");
        lines.push(chalk.bold("Stages:"));
        for (const s of result.stages)
          lines.push(
            `  ${s.name} / ${s.executor} / ${colorizeReview(String(s.reviewVerdict ?? (s.exitCode === 0 ? "PASS" : "FAIL")))}`,
          );
      }
      if (result.acceptanceEvidence && result.acceptanceEvidence.length) {
        lines.push("");
        lines.push(chalk.bold("Acceptance:"));
        for (const ev of result.acceptanceEvidence)
          lines.push(
            `  ${ev.status === "evidence_available" ? chalk.green("✓") : chalk.gray("✗")} ${ev.criterion}`,
          );
      }
      const handback = truncateLines(result.handback, 15);
      if (handback) {
        lines.push("");
        lines.push(chalk.bold("Handback:"));
        lines.push(handback);
      }
    } else {
      lines.push("");
      lines.push(chalk.gray("（无 result.json，仅任务状态）"));
    }
    return lines.join("\n");
  }
  // markdown
  const md: string[] = [`# 任务 ${state.jobId}`, ""];
  md.push(`- 状态：\`${state.status}\``);
  md.push(`- 阶段：\`${state.phase ?? "—"}\``);
  md.push(`- 尝试次数：${state.attempt}`);
  if (state.reviewVerdict) md.push(`- 审查：\`${state.reviewVerdict}\``);
  if (state.error) md.push(`- 错误：\`${state.error}\``);
  if (result) {
    if (result.stages && result.stages.length) {
      md.push("", "## Stages", "");
      md.push("| Stage | Executor | Verdict |");
      md.push("|-------|----------|---------|");
      for (const s of result.stages)
        md.push(
          `| ${s.name} | ${s.executor} | ${s.reviewVerdict ?? (s.exitCode === 0 ? "PASS" : "FAIL")} |`,
        );
    }
    if (result.acceptanceEvidence && result.acceptanceEvidence.length) {
      md.push("", "## Acceptance", "");
      for (const ev of result.acceptanceEvidence)
        md.push(
          `- [${ev.status === "evidence_available" ? "x" : " "}] ${ev.criterion}`,
        );
    }
    const handback = truncateLines(result.handback, 15);
    if (handback) {
      md.push("", "## Handback", "");
      md.push("```", handback, "```");
    }
  } else {
    md.push("", "_（无 result.json，仅任务状态）_");
  }
  return md.join("\n");
}

export function renderWorkspacesTable(
  workspaces: Array<{
    path: string;
    name: string;
    jobsByStatus: Record<string, number>;
    queueDepth: number;
    paused: boolean;
    activeExecutors: number;
    gitBranch: string | null;
    error?: string;
  }>,
): string {
  if (workspaces.length === 0) return chalk.gray("无 workspace");
  const total = (w: { jobsByStatus: Record<string, number> }): number =>
    Object.values(w.jobsByStatus).reduce((a, b) => a + b, 0);
  const headers = ["Workspace", "Jobs", "Active", "Queue", "Paused", "Branch"];
  const rows = workspaces.map((w) => [
    w.name,
    String(total(w)),
    String(w.activeExecutors),
    String(w.queueDepth),
    w.paused ? chalk.yellow("paused") : "—",
    w.gitBranch ?? (w.error ? chalk.red("error") : "—"),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => displayWidth(String(r[i])))),
  );
  const line = (cells: string[]): string =>
    "  " +
    cells
      .map((c, i) => padDisplayEnd(c, widths[i]))
      .join("  ")
      .trimEnd();
  const out = [
    line(headers),
    "  " + widths.map((w) => "-".repeat(w)).join("  "),
  ];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}
