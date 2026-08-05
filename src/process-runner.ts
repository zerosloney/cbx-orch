import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";

export interface ProcessResult { code: number; timedOut: boolean; output: string; }

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

export function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, logFile?: string, pidFile?: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if (pidFile && child.pid) writeFileSync(pidFile, String(child.pid), "utf8");
    let output = "";
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      if (logFile) appendFileSync(logFile, text, "utf8");
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
      resolve({ code: code ?? -1, timedOut, output });
    });
  });
}

export function runShell(command: string, cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer) => { output += chunk.toString("utf8"); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid, "SIGKILL", child); }, timeoutMs);
    child.on("error", error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on("close", code => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: code ?? -1, timedOut, output }); } });
  });
}
