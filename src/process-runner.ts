import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";

export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

/** killTree 发出后 close 仍未到达（孤儿孙进程持有 stdio 管道、kill 失败等）时，
 *  最多再等这么久就强制结算，防止调用方（worker / UI）因 promise 悬挂。 */
export const FORCE_SETTLE_MS = 3_000;

export interface ProcessResult {
  code: number;
  timedOut: boolean;
  output: string;
  outputTruncated?: boolean;
}

class BoundedOutput {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private readonly maximumBytes: number;
  truncated = false;

  constructor(maximumBytes = MAX_CAPTURE_BYTES) {
    this.maximumBytes = maximumBytes;
  }

  append(chunk: Buffer): void {
    const copy = Buffer.from(chunk);
    this.chunks.push(copy);
    this.bytes += copy.length;
    while (this.bytes > this.maximumBytes && this.chunks.length > 0) {
      const excess = this.bytes - this.maximumBytes;
      const first = this.chunks[0];
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
      }
      this.truncated = true;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }
}

export function capture(
  args: string[],
  cwd: string,
  timeout = 30_000,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  return {
    code: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error ?? ""),
  };
}

/** 异步版 capture：不阻塞调用方事件循环。用于主进程内的 UI/调度路径（SSE 心跳、多客户端共享事件循环）；
 *  worker 进程内的 git-ops 调用保持同步 capture——worker 是单用途进程，阻塞无副作用，且调用链全同步更简单。
 *  输出与 runProcess 一致走 BoundedOutput（默认 4MB 上限，保留尾部），避免大仓库 git 输出撑爆 UI 进程内存。 */
export function captureAsync(
  args: string[],
  cwd: string,
  timeout = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new BoundedOutput();
    const stderr = new BoundedOutput();
    let killGraceTimer: NodeJS.Timeout | undefined;
    const settle = (code: number, stderrText?: string) => {
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      resolve({
        code,
        stdout: stdout.text(),
        stderr: stderrText ?? stderr.text(),
      });
    };
    const timer = setTimeout(() => {
      // 树杀而非只杀直接子进程：孙进程持有管道时 close 会永不到达，UI 请求将永久挂起。
      if (child.pid) killTree(child.pid, "SIGKILL", child);
      killGraceTimer = setTimeout(
        () => settle(-1),
        FORCE_SETTLE_MS,
      );
    }, timeout);
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (error: Error) => {
      settle(-1, String(error.message ?? error));
    });
    child.on("close", (code: number | null) => {
      settle(code ?? -1);
    });
  });
}

export function killTree(
  pid: number,
  signal: NodeJS.Signals = "SIGKILL",
  child?: ChildProcess,
): boolean {
  if (process.platform === "win32") {
    // taskkill /T 以根 pid 为起点遍历进程树，必须趁根进程还活着时先执行：
    // 一旦先用 child.kill 杀掉根，孙进程已被系统过继成孤儿，/T 无法再枚举到它们。
    // （旧实现有句柄时短路返回，导致每次超时后孙进程存活并继续改写工作区。）
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
    if (result.status === 0 || !treeAlive(pid)) return true;
    // 受限会话/作业对象下 taskkill 可能失败：退回本进程持有的句柄，再退回 pid 直杀。
    if (child) {
      try {
        if (child.kill("SIGKILL")) return true;
      } catch {
        /* 进程已退出 */
      }
    }
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    if (child) {
      try {
        return child.kill(signal);
      } catch {
        /* 进程已退出 */
      }
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function treeAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function waitUntilStopped(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (treeAlive(pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return !treeAlive(pid);
}

/** Gracefully stop a process group, escalate to SIGKILL, and confirm it is gone. */
export async function terminateTree(
  pid: number,
  gracefulMs = 2_000,
  forceMs = 1_000,
): Promise<boolean> {
  if (!treeAlive(pid)) return true;
  killTree(pid, "SIGTERM");
  if (await waitUntilStopped(pid, gracefulMs)) return true;
  killTree(pid, "SIGKILL");
  return waitUntilStopped(pid, forceMs);
}

import { LineStreamAccumulator } from "./log-filter.js";
import type { LogEventFilter, LogFilterContext } from "./log-filter.js";
import type { StreamLogEvent } from "./types.js";

export interface ProcessStreamOptions {
  filter?: LogEventFilter;
  filterContext?: LogFilterContext;
  onLogEvent?: (event: StreamLogEvent) => void;
}

/** 共享子进程执行核心。runProcess(shell:false) 与 runShell(shell:true) 仅 spawn 形式不同，
 *  其余（pidFile / 有界输出 / 超时 SIGKILL / 错误与 close 的 settled 守卫 / pidFile 清理）完全一致。
 *  抽到这里避免两份 ~60 行副本漂移。 */
function runChild(
  useShell: boolean,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  logFile?: string,
  pidFile?: string,
  streamOptions?: ProcessStreamOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = useShell
      ? spawn(command, {
          cwd,
          shell: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        })
      : spawn(command, args, {
          cwd,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
    if (pidFile && child.pid) writeFileSync(pidFile, String(child.pid), "utf8");
    const output = new BoundedOutput();
    let timedOut = false;
    let settled = false;

    let accumulator: LineStreamAccumulator | undefined;
    if (streamOptions?.filter && streamOptions.onLogEvent) {
      accumulator = new LineStreamAccumulator(streamOptions.filter);
    }

    const append = (chunk: Buffer) => {
      output.append(chunk);
      if (logFile) appendFileSync(logFile, chunk);
      if (accumulator && streamOptions?.onLogEvent) {
        const ctx = streamOptions.filterContext ?? {
          jobId: "",
          executor: "",
        };
        const events = accumulator.feed(chunk, ctx);
        for (const evt of events) {
          streamOptions.onLogEvent(evt);
        }
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let killGraceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid, "SIGKILL", child);
      // close 可能永不到达：孤儿孙进程仍持有 stdio 管道句柄、或 kill 失败。宽限期满后
      // 强制结算，避免 worker 因 promise 悬挂 → 心跳过期 → 队列反复回收（每次回收心跳
      // 重置会绕过 MAX_RECLAIMS 熔断，形成 30s 摆振）。
      killGraceTimer = setTimeout(() => {
        if (settled) return;
        try {
          if (child.pid) killTree(child.pid, "SIGKILL");
        } catch {
          /* 尽力而为 */
        }
        settle(child.exitCode);
      }, FORCE_SETTLE_MS);
    }, timeoutMs);

    const flushStream = () => {
      if (accumulator && streamOptions?.onLogEvent) {
        const ctx = streamOptions.filterContext ?? {
          jobId: "",
          executor: "",
        };
        const events = accumulator.flush(ctx);
        for (const evt of events) {
          streamOptions.onLogEvent(evt);
        }
      }
    };

    const cleanupPidFile = () => {
      if (pidFile) {
        try {
          unlinkSync(pidFile);
        } catch {
          /* removed */
        }
      }
    };

    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      flushStream();
      cleanupPidFile();
      resolve({
        code: code ?? -1,
        timedOut,
        output: output.text(),
        ...(output.truncated ? { outputTruncated: true } : {}),
      });
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      flushStream();
      cleanupPidFile();
      reject(error);
    });
    child.on("close", (code) => settle(code));
  });
}

export function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  logFile?: string,
  pidFile?: string,
  streamOptions?: ProcessStreamOptions,
): Promise<ProcessResult> {
  return runChild(
    false,
    command,
    args,
    cwd,
    timeoutMs,
    logFile,
    pidFile,
    streamOptions,
  );
}

export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  logFile?: string,
  pidFile?: string,
  streamOptions?: ProcessStreamOptions,
): Promise<ProcessResult> {
  return runChild(
    true,
    command,
    [],
    cwd,
    timeoutMs,
    logFile,
    pidFile,
    streamOptions,
  );
}

