import chalk from "chalk";
import {
  clearScreen,
  getSize,
  hideCursor,
  moveCursor,
  showCursor,
} from "./screen.js";
import { startKeyboardListener, type KeyAction } from "./keyboard.js";
import { renderStatusBar } from "./components/status-bar.js";
import { buildRows, renderJobTable } from "./components/job-table.js";
import { renderDetailPane } from "./components/detail-pane.js";
import { colorizeStatus } from "./theme.js";
import { fmtTime } from "../formatting.js";
import type { JobState, StageReport } from "../types.js";
import type { QueueFile } from "../queue.js";
import { buildTimeline, type JobTimeline } from "../ui.js";
import {
  approveJob,
  cancelJob,
  listJobs,
  listQueue,
  pauseQueue,
  readArtifact,
  readEventsIncremental,
  resumeQueue,
  retryQueueJob,
  startBackground,
} from "../core.js";
import { captureAsync } from "../process-runner.js";

interface TuiState {
  jobs: JobState[];
  queue: QueueFile;
  gitBranch: string | null;
  selectedIndex: number;
  queuePaused: boolean;
  stopped: boolean;
  needsRedraw: boolean;
  detail: { timeline: JobTimeline | null; stages: StageReport[] | null };
  eventStream: { lines: string[]; offset: number };
}

interface TuiKeyState {
  jobs: JobState[];
  selectedIndex: number;
  queuePaused: boolean;
  stopped: boolean;
  needsRedraw: boolean;
}

type IntervalScheduler = (
  callback: () => void,
  intervalMs: number,
) => ReturnType<typeof setInterval>;

export function handleTuiKey(
  action: KeyAction,
  state: TuiKeyState,
  refresh: () => void | Promise<void>,
  queueAction?: (
    action: "pause" | "resume" | "cancel" | "approve" | "retry" | "continue",
    jobId?: string,
  ) => void | Promise<void>,
): void {
  switch (action) {
    case "quit":
      state.stopped = true;
      break;
    case "up":
      state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      state.needsRedraw = true;
      break;
    case "down":
      // 下界 0：空 jobs 时 jobs.length-1=-1，Math.min 会得 -1，需 clamp。
      state.selectedIndex = Math.max(
        0,
        Math.min(state.jobs.length - 1, state.selectedIndex + 1),
      );
      state.needsRedraw = true;
      break;
    case "refresh":
      state.needsRedraw = true;
      void refresh();
      break;
    case "pause":
    case "resume":
      // 队列暂停/恢复：同步切换本地状态，随后调用队列操作并触发刷新。
      state.queuePaused = action === "pause";
      state.needsRedraw = true;
      void queueAction?.(action);
      break;
    case "cancel": {
      const jobId = state.jobs[state.selectedIndex]?.jobId;
      if (!jobId) return; // 未选中任务时忽略
      state.needsRedraw = true;
      void queueAction?.("cancel", jobId);
      break;
    }
    case "approve": {
      // 仅批准 awaiting_approval 任务（before_run / before_complete 两阶段都停在此状态）。
      const job = state.jobs[state.selectedIndex];
      if (!job || job.status !== "awaiting_approval") return;
      state.needsRedraw = true;
      void queueAction?.("approve", job.jobId);
      break;
    }
    case "retry": {
      // 仅失败终态可重试；running/queued/awaiting_approval 不可。
      const job = state.jobs[state.selectedIndex];
      if (
        !job ||
        !["failed", "needs_fix", "review_failed", "cancelled"].includes(
          job.status,
        )
      )
        return;
      state.needsRedraw = true;
      void queueAction?.("retry", job.jobId);
      break;
    }
    case "continue": {
      // 仅 needs_fix / review_failed 可续跑（gate 等待类）。
      const job = state.jobs[state.selectedIndex];
      if (!job || !["needs_fix", "review_failed"].includes(job.status)) return;
      state.needsRedraw = true;
      void queueAction?.("continue", job.jobId);
      break;
    }
  }
}

export function scheduleTuiPoll(
  refresh: () => void | Promise<void>,
  intervalMs: number,
  schedule: IntervalScheduler = setInterval,
): ReturnType<typeof setInterval> {
  const timer = schedule(() => void refresh(), intervalMs);
  timer.unref();
  return timer;
}

async function fetchData(workspace: string, state: TuiState): Promise<void> {
  try {
    const [jobs, queue] = await Promise.all([
      listJobs(workspace),
      listQueue(workspace),
    ]);
    state.jobs = jobs;
    state.queue = queue;
    state.queuePaused = queue.paused;
    // git branch（异步：TUI 主循环每秒轮询，同步 git 会卡住键盘响应）
    try {
      const result = await captureAsync(
        ["git", "branch", "--show-current"],
        workspace,
      );
      state.gitBranch = result.code === 0 ? result.stdout.trim() || null : null;
    } catch {
      state.gitBranch = null;
    }
    // 如果选中索引超出范围，重置
    if (state.selectedIndex >= jobs.length) {
      state.selectedIndex = Math.max(0, jobs.length - 1);
    }
    // 详情投影：选中任务并行拉 timeline（ui.ts buildTimeline）+ stage 链（result.json.stages）。
    // 服务端投影原则——不直接读 SQLite，失败静默保留上一次详情。
    const selectedJob = jobs[state.selectedIndex];
    if (selectedJob) {
      try {
        const [timeline, resultText] = await Promise.all([
          buildTimeline(workspace, selectedJob.jobId),
          readArtifact(workspace, selectedJob.jobId, "result.json").catch(
            () => "{}",
          ),
        ]);
        let stages: StageReport[] | null = null;
        try {
          const parsed = JSON.parse(resultText) as { stages?: StageReport[] };
          stages = Array.isArray(parsed.stages) ? parsed.stages : null;
        } catch {
          stages = null;
        }
        state.detail = { timeline, stages };
      } catch {
        /* 详情获取失败保留上一次 */
      }
      // 事件流：增量游标拉取 events.ndjson，仅追加新事件（上限 5 条），失败静默保留上一次。
      try {
        const { events, next_offset } = await readEventsIncremental(
          workspace,
          selectedJob.jobId,
          state.eventStream.offset,
        );
        const fresh = [...state.eventStream.lines, ...events];
        state.eventStream = {
          lines: fresh.slice(-5),
          offset: next_offset,
        };
      } catch {
        /* 事件流获取失败保留上一次 */
      }
    } else {
      state.detail = { timeline: null, stages: null };
      state.eventStream = { lines: [], offset: 0 };
    }
    state.needsRedraw = true;
  } catch {
    /* 静默失败，下次轮询再试 */
  }
}

function draw(state: TuiState): void {
  const { rows, cols } = getSize();
  clearScreen();
  moveCursor(0, 0);

  // 状态栏 1 行
  console.log(renderStatusBar(state.queue, state.gitBranch));

  // 详情面板：先算行数（无选中1行；选中4行；含error/stage链/时间线更多），动态决定表格高度避免小屏溢出。
  const selectedJob = state.jobs[state.selectedIndex];
  const detail = renderDetailPane(
    selectedJob,
    state.detail.timeline,
    state.detail.stages,
  );
  // 事件流面板：最多 5 行最近事件（时间 + 类型着色），并入详情行数计算以保持表格防溢出。
  const eventLines: string[] = [];
  if (state.eventStream.lines.length) {
    eventLines.push(chalk.bold("事件:"));
    for (const line of state.eventStream.lines) {
      try {
        const ev = JSON.parse(line) as {
          at?: string;
          event?: string;
          status?: string;
        };
        const at = ev.at ? ` ${fmtTime(ev.at)}` : "";
        const type = String(ev.event ?? "?");
        const status =
          typeof ev.status === "string" ? colorizeStatus(ev.status) : type;
        eventLines.push(`  ${at} ${status}`);
      } catch {
        /* 跳过无法解析的事件行 */
      }
    }
  }
  const detailLines = detail.split("\n").length + eventLines.length;
  // 表格总占 = 表头2 + 数据 tableHeight + 溢出标记0/1；其余固定 = 状态栏1 + 空行2 + 详情/事件 + 提示1
  const tableHeight = Math.max(3, rows - detailLines - 7);
  const rowsData = buildRows(state.jobs);
  const table = renderJobTable(
    rowsData,
    state.selectedIndex,
    tableHeight,
    cols,
  );
  console.log(table);

  console.log("\n" + detail);
  if (eventLines.length) console.log("\n" + eventLines.join("\n"));

  // 底部提示
  console.log(
    "\n" +
      "按 ↑/↓ 选择 · r 刷新 · p 暂停 · u 恢复 · x 取消 · a 批准 · y 重试 · n 继续 · q 退出".replace(
        /./g,
        (c) => "\x1b[90m" + c + "\x1b[0m",
      ),
  );

  state.needsRedraw = false;
}

export async function startTui(
  workspace: string,
  intervalMs = 1000,
): Promise<void> {
  const state: TuiState = {
    jobs: [],
    queue: {
      maxConcurrent: 0,
      paused: false,
      entries: [],
      updatedAt: "",
    },
    gitBranch: null,
    selectedIndex: 0,
    queuePaused: false,
    stopped: false,
    needsRedraw: true,
    detail: { timeline: null, stages: null },
    eventStream: { lines: [], offset: 0 },
  };

  await fetchData(workspace, state);
  const onSigint = (): void => {
    state.stopped = true;
  };
  const queueAction = (
    action: "pause" | "resume" | "cancel" | "approve" | "retry" | "continue",
    jobId?: string,
  ): void => {
    // approve 需复刻 CLI/MCP 语义：before_run 批准后状态回 queued，需显式 startBackground。
    const approveAndStart = async (id: string): Promise<void> => {
      const state = await approveJob(workspace, id);
      if (state.status === "queued") await startBackground(workspace, id);
    };
    const operation =
      action === "pause"
        ? pauseQueue(workspace)
        : action === "resume"
          ? resumeQueue(workspace)
          : action === "approve" && jobId
            ? approveAndStart(jobId)
            : action === "retry" && jobId
              ? retryQueueJob(workspace, jobId)
              : action === "continue" && jobId
                ? startBackground(
                    workspace,
                    jobId,
                    "请根据 review.md 修复问题。",
                  )
                : action === "cancel" && jobId
                  ? cancelJob(workspace, jobId)
                  : Promise.resolve();
    void operation
      .catch((error) =>
        console.error(
          `cbx: TUI ${action} 失败：${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .then(() => fetchData(workspace, state));
  };
  let stopKeyboard: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let drawTimer: ReturnType<typeof setInterval> | undefined;
  let stopCheckTimer: ReturnType<typeof setInterval> | undefined;

  hideCursor();
  try {
    stopKeyboard = startKeyboardListener((action: KeyAction) => {
      handleTuiKey(
        action,
        state,
        () => fetchData(workspace, state),
        queueAction,
      );
    });
    process.once("SIGINT", onSigint);

    // 按调用方配置的间隔轮询拉数据。
    pollTimer = scheduleTuiPoll(() => fetchData(workspace, state), intervalMs);

    // 每秒刷新显示（更新 elapsed）
    drawTimer = setInterval(() => {
      if (state.needsRedraw) draw(state);
    }, 1000);
    drawTimer.unref();

    // 初始绘制
    draw(state);

    // 等待停止
    await new Promise<void>((resolve) => {
      stopCheckTimer = setInterval(() => {
        if (state.stopped) resolve();
      }, 100);
      stopCheckTimer.unref();
    });
  } finally {
    if (stopCheckTimer) clearInterval(stopCheckTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (drawTimer) clearInterval(drawTimer);
    process.removeListener("SIGINT", onSigint);
    stopKeyboard?.();
    showCursor();
    clearScreen();
    moveCursor(0, 0);
    console.log("CBX TUI 已退出。");
  }
}
