import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";

export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface ProcessResult { code: number; timedOut: boolean; output: string; outputTruncated?: boolean; }

class BoundedOutput {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private readonly maximumBytes: number;
  truncated = false;

  constructor(maximumBytes = MAX_CAPTURE_BYTES) { this.maximumBytes = maximumBytes; }

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

  text(): string { return Buffer.concat(this.chunks, this.bytes).toString("utf8"); }
}

export function capture(args: string[], cwd: string, timeout = 30_000): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8", timeout, windowsHide: true });
  return { code: result.status ?? -1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? result.error ?? "") };
}

export function killTree(pid: number, signal: NodeJS.Signals = "SIGKILL", child?: ChildProcess): boolean {
  if (process.platform === "win32") {
    // 先尝试父进程持有的句柄：在某些环境（受限会话/作业对象）下，先执行失败的 taskkill
    // 会使后续 child.kill 失效（返回 false），因此有句柄时必须优先用它（TerminateProcess）。
    if (child) {
      try {
        if (child.kill("SIGKILL")) return true;
      } catch { /* 进程已退出 */ }
    }
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    if (result.status === 0) return true;
    try { process.kill(pid, "SIGKILL"); return true; } catch { return false; }
  }
  try { process.kill(-pid, signal); return true; } catch {
    if (child) {
      try { return child.kill(signal); } catch { /* 进程已退出 */ }
    }
    try { process.kill(pid, signal); return true; } catch { return false; }
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

async function waitUntilStopped(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (treeAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  return !treeAlive(pid);
}

/** Gracefully stop a process group, escalate to SIGKILL, and confirm it is gone. */
export async function terminateTree(pid: number, gracefulMs = 2_000, forceMs = 1_000): Promise<boolean> {
  if (!treeAlive(pid)) return true;
  killTree(pid, "SIGTERM");
  if (await waitUntilStopped(pid, gracefulMs)) return true;
  killTree(pid, "SIGKILL");
  return waitUntilStopped(pid, forceMs);
}

export function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, logFile?: string, pidFile?: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if (pidFile && child.pid) writeFileSync(pidFile, String(child.pid), "utf8");
    const output = new BoundedOutput();
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer) => {
      output.append(chunk);
      if (logFile) appendFileSync(logFile, chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid, "SIGKILL", child); }, timeoutMs);
    child.on("error", error => {
      if (!settled) { settled = true; clearTimeout(timer); if (pidFile) { try { unlinkSync(pidFile); } catch { /* removed */ } } reject(error); }
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pidFile) { try { unlinkSync(pidFile); } catch { /* removed */ } }
      resolve({ code: code ?? -1, timedOut, output: output.text(), ...(output.truncated ? { outputTruncated: true } : {}) });
    });
  });
}

export function runShell(command: string, cwd: string, timeoutMs: number, logFile?: string, pidFile?: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if (pidFile && child.pid) writeFileSync(pidFile, String(child.pid), "utf8");
    const output = new BoundedOutput();
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer) => { output.append(chunk); if (logFile) appendFileSync(logFile, chunk); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid, "SIGKILL", child); }, timeoutMs);
    child.on("error", error => { if (!settled) { settled = true; clearTimeout(timer); if (pidFile) { try { unlinkSync(pidFile); } catch { /* removed */ } } reject(error); } });
    child.on("close", code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (pidFile) { try { unlinkSync(pidFile); } catch { /* removed */ } }
        resolve({ code: code ?? -1, timedOut, output: output.text(), ...(output.truncated ? { outputTruncated: true } : {}) });
      }
    });
  });
}
