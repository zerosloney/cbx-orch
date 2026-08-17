import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { atomicWriteFile, loadJson, now, saveJson } from "./storage.js";
import { capture } from "./process-runner.js";

const CODE_PATHS = [".", ":(exclude).cbx", ":(exclude).cbx/**"];

export function gitRoot(workspace: string): string | undefined {
  const result = capture(["git", "rev-parse", "--show-toplevel"], workspace);
  return result.code === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : undefined;
}

export interface GitBaseline { root: string; commit?: string; branch?: string; dirty: boolean; status: string; }

export function snapshotGitBaseline(workspace: string): GitBaseline | undefined {
  const root = gitRoot(workspace);
  if (!root) return undefined;
  const commit = capture(["git", "rev-parse", "HEAD"], root);
  const branch = capture(["git", "branch", "--show-current"], root);
  const status = capture(["git", "status", "--porcelain", "--untracked-files=all", "--", ...CODE_PATHS], root);
  return {
    root,
    commit: commit.code === 0 ? commit.stdout.trim() : undefined,
    branch: branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim() : undefined,
    dirty: Boolean(status.stdout.trim()),
    status: status.stdout,
  };
}

export function gitDirtyFingerprint(workspace: string): string | undefined {
  const root = gitRoot(workspace);
  if (!root) return undefined;
  const status = capture(["git", "status", "--porcelain", "--untracked-files=all", "--", ...CODE_PATHS], root);
  const tracked = trackedDiff(root);
  const paths = capture(["git", "ls-files", "--others", "--exclude-standard", "-z", "--", ...CODE_PATHS], root).stdout.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256").update(status.stdout).update("\0").update(tracked);
  for (const relative of paths) {
    const blob = capture(["git", "hash-object", "--no-filters", "--", relative], root);
    hash.update("\0").update(relative).update("\0").update(blob.code === 0 ? blob.stdout.trim() : `ERROR:${blob.stderr.trim()}`);
  }
  return hash.digest("hex");
}

export async function prepareWorktree(workspace: string, directory: string, jobId: string, isolated: boolean, autoBranch = false, baseCommit = "HEAD"): Promise<string> {
  if (!isolated) return workspace;
  const root = gitRoot(workspace);
  if (!root) throw new Error("--isolated 要求工作区位于 Git 仓库中。");
  const target = path.join(path.dirname(root), `.${path.basename(root)}.cbx-worktrees`, jobId);
  await mkdir(path.dirname(target), { recursive: true });
  const branch = `cbx/${jobId}`;
  const branchExists = capture(["git", "show-ref", "--verify", `refs/heads/${branch}`], root).code === 0;
  const args = autoBranch && branchExists ? ["git", "worktree", "add", target, branch] : autoBranch ? ["git", "worktree", "add", "-b", branch, target, baseCommit] : ["git", "worktree", "add", "--detach", target, baseCommit];
  const result = capture(args, root);
  if (result.code !== 0) throw new Error(`创建 Git worktree 失败：\n${result.stderr.trim()}`);
  await saveJson(path.join(directory, "worktree.json"), { path: target, branch: autoBranch ? branch : undefined, baseCommit, createdAt: now() });
  return target;
}

export async function cleanupRecordedWorktree(workspace: string, directory: string): Promise<boolean> {
  const root = gitRoot(workspace);
  const expectedParent = root ? path.resolve(path.dirname(root), `.${path.basename(root)}.cbx-worktrees`) : "";
  let cleanedAny = false;

  const files = existsSync(directory) ? await readdir(directory) : [];
  const targetFiles = files.filter(f => f === "worktree.json" || /^worktree-stage-\d+\.json$/.test(f));

  for (const file of targetFiles) {
    const filePath = path.join(directory, file);
    try {
      const record = await loadJson<{ path: string }>(filePath);
      const target = path.resolve(record.path);
      if (root && path.dirname(target) === expectedParent) {
        capture(["git", "worktree", "remove", "--force", target], root);
        cleanedAny = true;
      }
    } catch { /* best-effort */ }
  }

  if (expectedParent && existsSync(expectedParent)) {
    try {
      const remaining = await readdir(expectedParent);
      if (remaining.length === 0) await rmdir(expectedParent);
    } catch { /* best-effort */ }
  }
  if (cleanedAny) {
    await saveJson(path.join(directory, "worktree-cleaned.json"), { cleanedAt: now() });
  }
  return cleanedAny;
}

function trackedDiff(workdir: string, baseRef = "HEAD"): string {
  const againstBase = capture(["git", "diff", "--binary", baseRef, "--", ...CODE_PATHS], workdir);
  if (againstBase.code === 0) return againstBase.stdout;
  // Unborn repositories do not have HEAD yet.
  const staged = capture(["git", "diff", "--binary", "--cached", "--", ...CODE_PATHS], workdir);
  const unstaged = capture(["git", "diff", "--binary", "--", ...CODE_PATHS], workdir);
  return staged.stdout + unstaged.stdout + (staged.code || unstaged.code ? staged.stderr + unstaged.stderr : "");
}

async function untrackedSections(workdir: string, paths: string[]): Promise<{ listing: string; patches: string }> {
  const listing: string[] = [];
  const patches: string[] = [];
  const root = path.resolve(workdir) + path.sep;
  for (const relative of paths) {
    const file = path.resolve(workdir, relative);
    if (!file.startsWith(root)) continue;
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (info.size > 200_000) {
        listing.push(`## ${relative}\n[跳过超过 200KB 的文件]\n`);
        patches.push(`diff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n[文件超过 200KB，内容见 worktree]\n`);
        continue;
      }
      const content = await readFile(file, "utf8");
      listing.push(`## ${relative}\n\n${content}\n`);
      const sourceLines = content.split(/\r?\n/);
      const lines = sourceLines.map(line => `+${line}`).join("\n");
      patches.push(`diff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${sourceLines.length} @@\n${lines}\n`);
    } catch {
      listing.push(`## ${relative}\n[二进制或不可读取文件]\n`);
      patches.push(`diff --git a/${relative} b/${relative}\nnew file mode 100644\n[二进制或不可读取文件]\n`);
    }
  }
  return { listing: listing.join("\n"), patches: patches.join("\n") };
}

export interface DiffSnapshot { status: string; tracked: string; untracked: string; complete: string; }

/** baseRef 可选：并行 stage 模式主 worktree 含中间层 commit 时，diff 必须对任务基线（而非 HEAD）计算。 */
export async function snapshotDiff(
  workdir: string,
  baseRef = "HEAD",
): Promise<DiffSnapshot> {
  const statusResult = capture(["git", "status", "--short", "--untracked-files=all", "--", ...CODE_PATHS], workdir);
  const tracked = trackedDiff(workdir, baseRef);
  const pathsResult = capture(["git", "ls-files", "--others", "--exclude-standard", "-z", "--", ...CODE_PATHS], workdir);
  const paths = pathsResult.stdout.split("\0").filter(Boolean).sort();
  const untracked = await untrackedSections(workdir, paths);
  return {
    status: statusResult.stdout + (statusResult.code === 0 ? "" : statusResult.stderr),
    tracked,
    untracked: untracked.listing,
    complete: [tracked, untracked.patches].filter(Boolean).join("\n"),
  };
}

export async function collectDiff(
  directory: string,
  workdir: string,
  baseRef = "HEAD",
): Promise<DiffSnapshot> {
  const snapshot = await snapshotDiff(workdir, baseRef);
  await Promise.all([
    atomicWriteFile(path.join(directory, "git-status.txt"), snapshot.status),
    atomicWriteFile(path.join(directory, "diff.patch"), snapshot.tracked),
    atomicWriteFile(path.join(directory, "untracked-files.txt"), snapshot.untracked),
    atomicWriteFile(path.join(directory, "complete.patch"), snapshot.complete),
  ]);
  return snapshot;
}

export function commitWorktree(workdir: string, message: string): string | undefined {
  const status = capture(["git", "status", "--porcelain", "--", ...CODE_PATHS], workdir);
  if (status.code !== 0) throw new Error(`读取 Git 状态失败：${status.stderr.trim()}`);
  if (!status.stdout.trim()) return undefined;
  const add = capture(["git", "add", "-A", "--", ...CODE_PATHS], workdir);
  if (add.code !== 0) throw new Error(`git add 失败：${add.stderr.trim()}`);
  const commit = capture(["git", "commit", "-m", message], workdir);
  if (commit.code !== 0) throw new Error(`git commit 失败：${commit.stderr.trim()}`);
  const hash = capture(["git", "rev-parse", "HEAD"], workdir);
  if (hash.code !== 0) throw new Error(`读取提交哈希失败：${hash.stderr.trim()}`);
  return hash.stdout.trim();
}

// ---- 并行 stage 原语：每 stage 独立 worktree + 合并回主 worktree ----

/** 仓库缺失 user.name/email 时给内部提交注入 cbx 身份（`git -c` 前置参数）。
 *  仅用于 cbx 内部的 stage/layer 合并提交；用户触发的 autoCommit 语义不变。 */
function identityArgs(cwd: string): string[] {
  const name = capture(["git", "config", "user.name"], cwd);
  const email = capture(["git", "config", "user.email"], cwd);
  const args: string[] = [];
  if (!name.stdout.trim()) args.push("-c", "user.name=cbx-orch");
  if (!email.stdout.trim()) args.push("-c", "user.email=cbx-orch@localhost");
  return args;
}

/** 为 stage 创建独立 worktree（从 baseCommit 分离检出），记录 worktree-stage-<index>.json 供清理。
 *  返回 stage worktree 绝对路径。 */
export async function prepareStageWorktree(
  workspace: string,
  directory: string,
  jobId: string,
  stageIndex: number,
  baseCommit: string,
): Promise<string> {
  const root = gitRoot(workspace);
  if (!root) throw new Error("stage 并行要求工作区位于 Git 仓库中。");
  const target = path.join(
    path.dirname(root),
    `.${path.basename(root)}.cbx-worktrees`,
    `${jobId}-stage-${stageIndex}`,
  );
  await mkdir(path.dirname(target), { recursive: true });
  const result = capture(["git", "worktree", "add", "--detach", target, baseCommit], root);
  if (result.code !== 0)
    throw new Error(`创建 stage worktree 失败：\n${result.stderr.trim()}`);
  await saveJson(path.join(directory, `worktree-stage-${stageIndex}.json`), {
    path: target,
    baseCommit,
    createdAt: now(),
  });
  return target;
}

/** 移除单个 stage worktree（合并完成后调用；记录文件一并删除）。 */
export async function cleanupStageWorktree(
  workspace: string,
  directory: string,
  stageIndex: number,
): Promise<boolean> {
  const root = gitRoot(workspace);
  const recordFile = path.join(directory, `worktree-stage-${stageIndex}.json`);
  if (!root || !existsSync(recordFile)) return false;
  try {
    const record = await loadJson<{ path: string }>(recordFile);
    const target = path.resolve(record.path);
    const expectedParent = path.resolve(
      path.dirname(root),
      `.${path.basename(root)}.cbx-worktrees`,
    );
    if (path.dirname(target) !== expectedParent) return false;
    capture(["git", "worktree", "remove", "--force", target], root);
    await unlink(recordFile).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export interface StageMergeResult {
  merged: boolean;
  /** 冲突时非空：冲突文件相对路径列表（git merge 输出解析）。 */
  conflicts: string[];
}

/**
 * 把 stage worktree 的改动合并进主 worktree：
 * 1. stage 无改动 → 跳过（merged:true, 空冲突）；
 * 2. stage 改动提交到其 detached HEAD（身份缺失时注入 cbx 身份）；
 * 3. `git merge --no-commit --no-ff <stageHead>` 合入主 worktree；
 * 4. 冲突 → `git merge --abort` 还原主 worktree 并返回冲突文件列表（调用方决定失败语义）。
 */
export async function mergeStageIntoMain(
  mainWorkdir: string,
  stageWorkdir: string,
): Promise<StageMergeResult> {
  const status = capture(["git", "status", "--porcelain", "--", ...CODE_PATHS], stageWorkdir);
  if (status.code !== 0 || !status.stdout.trim()) return { merged: true, conflicts: [] };
  const add = capture(["git", "add", "-A", "--", ...CODE_PATHS], stageWorkdir);
  if (add.code !== 0)
    return { merged: false, conflicts: [`git add 失败：${add.stderr.trim()}`] };
  const commit = capture(
    ["git", ...identityArgs(stageWorkdir), "commit", "-m", "cbx: stage changes"],
    stageWorkdir,
  );
  if (commit.code !== 0)
    return { merged: false, conflicts: [`stage 提交失败：${commit.stderr.trim()}`] };
  const head = capture(["git", "rev-parse", "HEAD"], stageWorkdir);
  if (head.code !== 0)
    return { merged: false, conflicts: [`stage HEAD 读取失败：${head.stderr.trim()}`] };
  const merge = capture(
    ["git", "merge", "--no-commit", "--no-ff", head.stdout.trim()],
    mainWorkdir,
  );
  if (merge.code !== 0) {
    // 冲突：还原主 worktree 到合并前，返回冲突文件。
    capture(["git", "merge", "--abort"], mainWorkdir);
    const conflicts = merge.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^(CONFLICT|both (added|modified)|Auto-merging)/.test(line));
    return {
      merged: false,
      conflicts:
        conflicts.length > 0
          ? conflicts
          : [`合并冲突（${merge.stderr.trim().slice(0, 500)}）`],
    };
  }
  // 提交合并结果：层内多个 stage 顺序合并时，前一个合并必须先落 commit，git merge 才允许下一个。
  const mergedStatus = capture(["git", "status", "--porcelain"], mainWorkdir);
  if (mergedStatus.code === 0 && mergedStatus.stdout.trim()) {
    const mergedAdd = capture(["git", "add", "-A"], mainWorkdir);
    if (mergedAdd.code !== 0)
      return { merged: false, conflicts: [`合并暂存失败：${mergedAdd.stderr.trim()}`] };
    const mergedCommit = capture(
      ["git", ...identityArgs(mainWorkdir), "commit", "-m", "cbx: merge stage"],
      mainWorkdir,
    );
    if (mergedCommit.code !== 0)
      return {
        merged: false,
        conflicts: [`合并提交失败：${mergedCommit.stderr.trim()}`],
      };
  }
  return { merged: true, conflicts: [] };
}

/** 主 worktree 中间层合并提交（仅当后续还有层需要以它为基时调用）。空改动时返回当前 HEAD。 */
export function commitLayer(mainWorkdir: string, layer: number): string {
  const status = capture(["git", "status", "--porcelain", "--", ...CODE_PATHS], mainWorkdir);
  if (status.code === 0 && !status.stdout.trim())
    return capture(["git", "rev-parse", "HEAD"], mainWorkdir).stdout.trim();
  const add = capture(["git", "add", "-A", "--", ...CODE_PATHS], mainWorkdir);
  if (add.code !== 0) throw new Error(`git add 失败：${add.stderr.trim()}`);
  const commit = capture(
    ["git", ...identityArgs(mainWorkdir), "commit", "-m", `cbx: stage layer ${layer}`],
    mainWorkdir,
  );
  if (commit.code !== 0) throw new Error(`layer 提交失败：${commit.stderr.trim()}`);
  const head = capture(["git", "rev-parse", "HEAD"], mainWorkdir);
  if (head.code !== 0) throw new Error(`layer HEAD 读取失败：${head.stderr.trim()}`);
  return head.stdout.trim();
}

/** 主 worktree 当前 HEAD（stage worktree 的层基）。 */
export function worktreeHead(workdir: string): string {
  const head = capture(["git", "rev-parse", "HEAD"], workdir);
  if (head.code !== 0)
    throw new Error(`读取 worktree HEAD 失败：${head.stderr.trim()}`);
  return head.stdout.trim();
}
