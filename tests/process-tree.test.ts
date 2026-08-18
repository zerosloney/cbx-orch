import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  capture,
  captureAsync,
  FORCE_SETTLE_MS,
  killTree,
  runProcess,
  terminateTree,
} from "../src/process-runner.js";

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test("killTree 终止整棵进程树：孙进程随根进程死亡，不残留孤儿", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-tree-kill-"));
  // 孙进程：写 pid 后常驻 60s（若树杀失败它将存活，断言可检出）
  const grandchild = path.join(dir, "grandchild.mjs");
  await writeFile(
    grandchild,
    [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(process.argv[2], String(process.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  // 根进程：spawn 孙进程（普通子进程，属于同一进程树/进程组），随后常驻
  const root = path.join(dir, "root.mjs");
  await writeFile(
    root,
    [
      'import { spawn } from "node:child_process";',
      'spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore" });',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const marker = path.join(dir, "grandchild.pid");
  const child = spawn(process.execPath, [root, grandchild, marker], {
    stdio: "ignore",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const rootPid = child.pid ?? 0;
  let grandchildPid = 0;
  assert.ok(rootPid, "root pid");
  try {
    assert.equal(
      await waitFor(() => existsSync(marker), 10_000),
      true,
      "孙进程已启动并写入 pid",
    );
    grandchildPid = Number(await readFile(marker, "utf8"));
    killTree(rootPid, "SIGKILL", child);
    assert.equal(
      await waitFor(() => !pidAlive(grandchildPid), 10_000),
      true,
      "孙进程已被树杀（修复前 Windows 上 child.kill 短路导致孙进程成孤儿）",
    );
    assert.equal(pidAlive(rootPid), false, "根进程已死亡");
  } finally {
    try {
      killTree(rootPid, "SIGKILL", child);
    } catch {
      /* 尽力清理 */
    }
    if (grandchildPid) {
      try {
        killTree(grandchildPid, "SIGKILL");
      } catch {
        /* 尽力清理 */
      }
    }
  }
});

test("runProcess 超时触发树杀并结算，close 被逃逸孙进程阻塞时靠强制结算返回", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-force-settle-"));
  // 根进程常驻触发超时树杀；孙进程继承 stdout/stderr 管道但 detached 脱离进程组
  // （POSIX 上逃逸组杀，Windows 上仍可被 /T 枚举）。POSIX 场景中 close 被孙进程
  // 管道长期阻塞，只能靠强制结算兜底返回——验证 runProcess 不会悬挂到 60s 后。
  const marker = path.join(dir, "escapee.pid");
  const gcCode =
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000);";
  const holder = path.join(dir, "holder.cjs");
  await writeFile(
    holder,
    [
      'const { spawn } = require("node:child_process");',
      `const gc = spawn(process.execPath, ["-e", ${JSON.stringify(gcCode)}, ${JSON.stringify(marker)}], { stdio: ["ignore", 1, 2], detached: true });`,
      "gc.unref();",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const started = Date.now();
  let escapeePid = 0;
  try {
    const result = await runProcess(process.execPath, [holder], dir, 500);
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.ok(
      elapsed < 500 + FORCE_SETTLE_MS + 5_000,
      `应在超时+宽限内结算，实际 ${elapsed}ms`,
    );
    if (process.platform !== "win32") {
      // POSIX：孙进程逃逸组杀并持有管道，结算必然经由强制结算路径（≥ 超时+宽限）
      assert.ok(
        elapsed >= 500 + FORCE_SETTLE_MS - 600,
        `POSIX 应经强制结算返回，实际 ${elapsed}ms`,
      );
    }
    if (existsSync(marker)) escapeePid = Number(await readFile(marker, "utf8"));
  } finally {
    if (escapeePid) {
      try {
        killTree(escapeePid, "SIGKILL");
      } catch {
        /* 尽力清理 */
      }
    }
  }
});

test("capture 返回非零退出码与 stderr", () => {
  const result = capture([process.execPath, "-e", "process.stderr.write('boom'); process.exit(7)"], ".", 5_000);
  assert.equal(result.code, 7);
  assert.match(result.stderr, /boom/);
});

test("captureAsync 正常捕获 stdout", async () => {
  const result = await captureAsync([process.execPath, "-e", "console.log('hello async')"], ".", 5_000);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello async/);
});

test("killTree 对已死进程不抛错且返回合理结果", () => {
  // 使用极大 pid，几乎不可能存在
  const result = killTree(999_999, "SIGKILL");
  assert.equal(typeof result, "boolean");
});

test("terminateTree 对已死进程直接返回 true", async () => {
  const ok = await terminateTree(999_999, 100, 100);
  assert.equal(ok, true);
});

test("runProcess 对不存在的命令抛出 ENOENT", async () => {
  await assert.rejects(
    runProcess("this-binary-does-not-exist-42", ["arg"], ".", 5_000),
    /ENOENT/,
  );
});
