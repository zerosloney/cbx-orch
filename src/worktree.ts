import path from "node:path";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { capture } from "./process-runner.js";
import { cleanupRecordedWorktree, gitRoot } from "./git-ops.js";
import { jobDir } from "./state.js";

export async function cleanupWorktree(workspaceInput: string, jobId: string): Promise<boolean> {
  const workspace = path.resolve(workspaceInput);
  const directory = jobDir(workspace, jobId);
  return cleanupRecordedWorktree(workspace, directory);
}

export interface OrphanWorktree {
  /** worktree 绝对路径。 */
  worktree: string;
  /** 解析出的 jobId（`<jobId>-stage-<index>` 条目已剥离 stage 后缀）。 */
  jobId: string;
}

/** 孤儿 worktree 巡检：`.<repo>.cbx-worktrees/` 下没有对应 `.cbx/jobs/<jobId>` 目录的条目
 *  （job 已被 purge/forget 而 worktree 清理失败/遗漏，或 jobDir 丢失）。只报告，不动手——
 *  jobDir 仍在的终态遗留走既有 `cbx clean <jobId>`，不在此误伤。 */
export async function scanOrphanWorktrees(
  workspaceInput: string,
): Promise<OrphanWorktree[]> {
  const workspace = path.resolve(workspaceInput);
  const root = gitRoot(workspace);
  if (!root) return [];
  const parent = path.join(
    path.dirname(root),
    `.${path.basename(root)}.cbx-worktrees`,
  );
  if (!existsSync(parent)) return [];
  const orphans: OrphanWorktree[] = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // stage worktree 命名 `<jobId>-stage-<index>`，归属同一 jobId。
    const jobId = entry.name.replace(/-stage-\d+$/, "");
    // readdir 条目名不含路径分隔符，直接拼路径做存在性检查即可（无需 assertJobId）。
    if (!existsSync(path.join(workspace, ".cbx", "jobs", jobId))) {
      orphans.push({ worktree: path.join(parent, entry.name), jobId });
    }
  }
  return orphans;
}

/** 移除孤儿 worktree：优先 `git worktree remove --force`（同步 git 元数据），
 *  失败回退 rm -rf；autoBranch 模式的 `cbx/<jobId>` 分支 best-effort 删除，
 *  最后 `git worktree prune` 清理悬空登记。 */
export async function removeOrphanWorktrees(
  workspaceInput: string,
  orphans: OrphanWorktree[],
): Promise<{
  removed: string[];
  failed: Array<{ worktree: string; error: string }>;
}> {
  const workspace = path.resolve(workspaceInput);
  const root = gitRoot(workspace);
  const removed: string[] = [];
  const failed: Array<{ worktree: string; error: string }> = [];
  for (const orphan of orphans) {
    const gitOk = root
      ? capture(["git", "worktree", "remove", "--force", orphan.worktree], root)
          .code === 0
      : false;
    if (!gitOk) {
      try {
        await rm(orphan.worktree, { recursive: true, force: true });
      } catch (error) {
        failed.push({
          worktree: orphan.worktree,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    // best-effort：分支不存在（detached/stage）或被其他 worktree 占用时静默失败。
    if (root) capture(["git", "branch", "-D", `cbx/${orphan.jobId}`], root);
    removed.push(orphan.worktree);
  }
  if (root && orphans.length > 0) capture(["git", "worktree", "prune"], root);
  return { removed, failed };
}
