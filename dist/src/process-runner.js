import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
export function capture(args, cwd, timeout = 30_000) {
    const result = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8", timeout, windowsHide: true });
    return { code: result.status ?? -1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? result.error ?? "") };
}
export function killTree(pid, signal = "SIGKILL") {
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        return;
    }
    try {
        process.kill(-pid, signal);
    }
    catch {
        try {
            process.kill(pid, signal);
        }
        catch { /* already exited */ }
    }
}
export function runProcess(command, args, cwd, timeoutMs, logFile, pidFile) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        if (pidFile && child.pid)
            writeFileSync(pidFile, String(child.pid), "utf8");
        let output = "";
        let timedOut = false;
        let settled = false;
        const append = (chunk) => {
            const text = chunk.toString("utf8");
            output += text;
            if (logFile)
                appendFileSync(logFile, text, "utf8");
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const timer = setTimeout(() => { timedOut = true; if (child.pid)
            killTree(child.pid); }, timeoutMs);
        child.on("error", error => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                if (pidFile) {
                    try {
                        unlinkSync(pidFile);
                    }
                    catch { /* removed */ }
                }
                reject(error);
            }
        });
        child.on("close", code => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (pidFile) {
                try {
                    unlinkSync(pidFile);
                }
                catch { /* removed */ }
            }
            resolve({ code: code ?? -1, timedOut, output });
        });
    });
}
export function runShell(command, cwd, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let output = "";
        let timedOut = false;
        let settled = false;
        const append = (chunk) => { output += chunk.toString("utf8"); };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const timer = setTimeout(() => { timedOut = true; if (child.pid)
            killTree(child.pid); }, timeoutMs);
        child.on("error", error => { if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
        } });
        child.on("close", code => { if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ code: code ?? -1, timedOut, output });
        } });
    });
}
