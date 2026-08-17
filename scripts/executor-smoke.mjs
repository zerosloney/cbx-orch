#!/usr/bin/env node
// 真实执行器 smoke：对每个已安装的内置执行器跑一次最小任务，验证 adapter 参数契约与真实 CLI 兼容。
// 未安装的执行器跳过（不算失败）；任何已安装执行器失败 → 非零退出。
//
// 用法：
//   npm run build && npm run smoke:executors                 # 全部已安装执行器
//   npm run build && npm run smoke:executors -- --executor qwen   # 只测指定执行器
//
// 注意：会真实调用编码 CLI（可能消耗 token / 网络 / 凭据），仅适合本地人工或手动触发的 CI 运行，
// 不属于 `npm test` 的默认套件——CI 矩阵没有安装任何编码 CLI，冒烟必须显式触发。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { BUILTIN_EXECUTORS, findExecutable, resolveExecutor } from "../dist/src/executors/builtin.js";

const SMOKE_TIMEOUT_MS = 90_000;

const onlyArgIndex = process.argv.indexOf("--executor");
const only = onlyArgIndex >= 0 ? process.argv[onlyArgIndex + 1] : undefined;

let passed = 0;
let skipped = 0;
let failed = 0;

for (const spec of BUILTIN_EXECUTORS) {
  if (only && spec.name !== only && !spec.aliases.includes(only)) continue;
  const command = findExecutable(spec);
  if (command.length === 0) {
    console.log(`SKIP ${spec.name}: 未安装（PATH 上找不到 ${spec.candidates.join(" / ")}）`);
    skipped += 1;
    continue;
  }
  // 临时 git 仓库内跑最小任务，避免污染真实工作区。
  const dir = mkdtempSync(path.join(os.tmpdir(), "cbx-smoke-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), "cbx executor smoke\n");
  spawnSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "cbx-smoke",
    GIT_AUTHOR_EMAIL: "smoke@cbx.test",
    GIT_COMMITTER_NAME: "cbx-smoke",
    GIT_COMMITTER_EMAIL: "smoke@cbx.test",
  };
  spawnSync("git", ["commit", "-m", "init", "--no-verify"], {
    cwd: dir,
    stdio: "ignore",
    env: gitEnv,
  });
  const resolved = resolveExecutor(spec.name);
  if (!resolved) {
    console.error(`FAIL ${spec.name}: 注册表解析失败`);
    failed += 1;
    continue;
  }
  const args = resolved.buildArgs({
    prompt: "不要修改任何文件，只回复 OK。",
    permissionMode: "auto",
    maxTurns: 1,
  });
  const startedAt = Date.now();
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: SMOKE_TIMEOUT_MS,
    env: process.env,
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const ok = result.status === 0 && !result.error;
  // 清理临时目录（真实编码 CLI 可能在目录内留下 worktree/缓存）。
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不掩盖结果 */
  }
  if (ok) {
    console.log(`PASS ${spec.name} (${elapsed}s)`);
    passed += 1;
  } else {
    const tail = (text) =>
      String(text ?? "").replace(/\s+/g, " ").trim().slice(-300);
    console.error(
      `FAIL ${spec.name} (${elapsed}s): status=${result.status} error=${result.error?.message ?? "无"}`,
    );
    console.error(`  stdout 尾: ${tail(result.stdout)}`);
    console.error(`  stderr 尾: ${tail(result.stderr)}`);
    failed += 1;
  }
}

console.log(`\nsmoke 结果：${passed} 通过 / ${skipped} 跳过（未安装）/ ${failed} 失败`);
if (failed > 0) {
  console.error(`存在失败执行器；adapter 参数可能已与真实 CLI 漂移，请对照 README 执行器表核对。`);
  process.exit(1);
}
if (passed === 0) {
  console.error("没有任何已安装执行器被测试。先安装至少一个编码 CLI（codebuddy/opencode/omp/cline/qwen）。");
  process.exit(2);
}
