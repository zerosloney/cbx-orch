import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpath as realpathCb } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  scanOrphanWorktrees,
  removeOrphanWorktrees,
} from "../src/worktree.js";
import { health } from "../src/queue-api.js";
import { initializeGitWorkspace } from "./helpers.js";

/** 真实路径归一化：promises API 无 .native，用 callback 版 fs.realpath.native
 *  （Windows 展开 8.3 短名、macOS 解析符号链接），与 git 报告的最终路径对齐。 */
const realpathNative = promisify(realpathCb.native);

function git(args: string[], cwd: string) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

/** 在 `.<repo>.cbx-worktrees/` 下真实注册一个 git worktree，模拟执行器遗留。 */
function addWorktree(workspace: string, name: string): string {
  const target = path.join(
    path.dirname(workspace),
    `.${path.basename(workspace)}.cbx-worktrees`,
    name,
  );
  const result = git(["worktree", "add", "--detach", target], workspace);
  assert.equal(result.status, 0, result.stderr);
  return target;
}

test("scanOrphanWorktrees reports worktrees whose job directory is gone", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-orphan-"));
  await initializeGitWorkspace(workspace);
  const orphan = addWorktree(workspace, "gone-job");
  const active = addWorktree(workspace, "live-job");
  // live-job 的任务目录存在（job 数据还在，worktree 不是孤儿）。
  await mkdir(path.join(workspace, ".cbx", "jobs", "live-job"), {
    recursive: true,
  });
  // CI 环境的 TEMP 路径与字符串形式可能不一致（Windows runner 的 8.3 短名
  // RUNNER~1、macOS 的 /var→/private/var 符号链接），git 报告的是真实路径；
  // 两边都归一化到真实路径再比较，本地与 CI 环境均成立。
  const orphanReal = await realpathNative(orphan);

  const orphans = await scanOrphanWorktrees(workspace);
  assert.equal(orphans.length, 1);
  assert.equal(await realpathNative(orphans[0].worktree), orphanReal);
  assert.equal(orphans[0].jobId, "gone-job");

  const result = await removeOrphanWorktrees(workspace, orphans);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.removed, [orphans[0].worktree]);
  assert.equal(existsSync(orphan), false, "orphan worktree should be removed");
  assert.equal(existsSync(active), true, "live worktree must not be touched");
});

test("stage-suffixed worktrees map back to their jobId (not orphans when job exists)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-orphan-"));
  await initializeGitWorkspace(workspace);
  // stage 命名约定：<jobId>-stage-<index>；jobId 为 "stage-job"。
  const stage = addWorktree(workspace, "stage-job-stage-0");
  // 主任务目录存在：`<jobId>-stage-<index>` 条目剥离后缀归属同一 jobId，不算孤儿。
  await mkdir(path.join(workspace, ".cbx", "jobs", "stage-job"), {
    recursive: true,
  });
  assert.deepEqual(await scanOrphanWorktrees(workspace), []);
  assert.equal(existsSync(stage), true);

  // job 目录被清理后（purge/forget），stage worktree 变为孤儿并被移除。
  await removeOrphanWorktrees(workspace, await scanOrphanWorktrees(workspace));
});

test("scanOrphanWorktrees returns empty outside a git repo", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-nogit-"));
  assert.deepEqual(await scanOrphanWorktrees(workspace), []);
});

test("health() surfaces worktree orphans alongside metrics", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-orphan-"));
  await initializeGitWorkspace(workspace);
  addWorktree(workspace, "health-job");
  const result = await health(workspace);
  assert.equal(result.status, "ok");
  assert.equal(result.worktreeOrphans.length, 1);
  assert.equal(result.worktreeOrphans[0].jobId, "health-job");
  assert.equal(typeof result.metrics.tokensUsed, "number");
});
