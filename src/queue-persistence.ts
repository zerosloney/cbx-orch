import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  database,
  databaseReadonly,
  now,
  withQueueTxLock,
  writeQueueRows,
  readQueueRows,
  type CbxDatabase,
  type PersistedQueueLike,
} from "./storage.js";
import { isMissing } from "./file-utils.js";

export async function loadPersistedState<T>(
  workspace: string,
  jobId: string,
): Promise<T | undefined> {
  const db = await databaseReadonly(workspace);
  const row = db
    .prepare("SELECT state_json FROM jobs WHERE job_id = ?")
    .get(jobId) as { state_json: string } | undefined;
  return row ? (JSON.parse(row.state_json) as T) : undefined;
}
export async function savePersistedState(
  workspace: string,
  jobId: string,
  value: unknown,
): Promise<void> {
  const db = await database(workspace);
  db.prepare(
    "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
  ).run(jobId, JSON.stringify(value), now());
}
export async function listPersistedStates<T>(
  workspace: string,
  limit?: number,
): Promise<T[]> {
  const db = await databaseReadonly(workspace);
  const rows =
    limit === undefined
      ? (db
          .prepare("SELECT state_json FROM jobs ORDER BY updated_at DESC")
          .all() as Array<{ state_json: string }>)
      : (db
          .prepare(
            "SELECT state_json FROM jobs ORDER BY updated_at DESC LIMIT ?",
          )
          .all(limit) as Array<{ state_json: string }>);
  // 单条损坏的 state_json 不应拖垮整个 listJobs/health：跳过坏行保持其他 job 可见，
  // 与 importLegacyData 的损坏行跳过策略一致；恢复需 cbx forget 后重建。
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.state_json) as T);
    } catch {
      /* skip corrupt row */
    }
  }
  return out;
}

/**
 * 单事务删除 jobId 在持久化层（jobs 表 + queue_entries 行）的全部记录。
 *
 * 与 `queue.cancelQueueEntries` 不同：cancel 是把 active entries 标 cancelled（审计可见），
 * forget 是把同 jobId 的所有 entries 物理删除。两者串联——上层先 cancel 杀活 worker
 * 并持久化 cancelled 状态，再 forget 清掉 entries 拋留，**单事务**确保 jobs 行删和
 * queue entries 删要么都成功要么都回滚，避免 listJobs 看不见但 queue 还残留的撕裂状态。
 *
 * 返回剩余 queue 长度供上层做断言与日志。
 */
export async function forgetPersistedJob(
  workspaceInput: string,
  jobId: string,
): Promise<{ deletedJob: boolean; remainingEntries: number }> {
  const workspace = path.resolve(workspaceInput);
  return withQueueTxLock(workspace, (db) => {
    const result = db
      .prepare("DELETE FROM jobs WHERE job_id = ?")
      .run(jobId);
    const deletedJob = result.changes > 0;
    db.prepare("DELETE FROM queue_entries WHERE job_id = ?").run(jobId);
    const remainingEntries = (
      db
        .prepare("SELECT COUNT(*) AS count FROM queue_entries")
        .get() as { count: number }
    ).count;
    return { deletedJob, remainingEntries };
  });
}

export async function loadPersistedQueue<T>(
  workspace: string,
  fallback: T,
): Promise<T> {
  const resolved = path.resolve(workspace);
  const db = await database(resolved);
  const stored = readQueueRows(db);
  if (stored) return stored as T;
  // 更早版本（SQLite 之前）的 queue.json 一次性导入行级表。
  const file = path.join(resolved, ".cbx", "queue.json");
  try {
    const imported = JSON.parse(
      await readFile(file, "utf8"),
    ) as PersistedQueueLike;
    db.transaction(() => writeQueueRows(db, imported, now()))();
    return imported as T;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return fallback;
}
export async function savePersistedQueue(
  workspace: string,
  value: unknown,
): Promise<void> {
  const db = await database(workspace);
  db.transaction(() =>
    writeQueueRows(db, value as PersistedQueueLike, now()),
  )();
}
export async function savePersistedStateAndQueue(
  workspace: string,
  jobId: string,
  state: unknown,
  queue: unknown,
): Promise<void> {
  const db = await database(workspace);
  db.transaction(() => {
    upsertJobStateRow(db, jobId, JSON.stringify(state));
    writeQueueRows(db, queue as PersistedQueueLike, now());
  })();
}

const UPSERT_JOB_SQL =
  "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at";

export function upsertJobStateRow(
  db: CbxDatabase,
  jobId: string,
  stateJson: string,
): void {
  db.prepare(UPSERT_JOB_SQL).run(jobId, stateJson, now());
}

export function finishQueueEntryRow(
  db: CbxDatabase,
  queueId: string,
  queueStatus: string,
): void {
  db.prepare(
    "UPDATE queue_entries SET status = ?, finished_at = ?, pid = NULL, updated_at = ? WHERE queue_id = ?",
  ).run(queueStatus, now(), now(), queueId);
}

export function resolveApprovalQueueRow(
  db: CbxDatabase,
  jobId: string,
  queueStatus: "done" | "failed",
): void {
  db.prepare(
    "UPDATE queue_entries SET status = ?, finished_at = ?, pid = NULL, updated_at = ? WHERE job_id = ? AND status = 'awaiting_approval'",
  ).run(queueStatus, now(), now(), jobId);
}

export function mapStateToQueueStatus(state: Record<string, unknown>): string {
  const status = String(state.status);
  return status === "done"
    ? "done"
    : status === "cancelled"
      ? "cancelled"
      : status === "awaiting_approval"
        ? "awaiting_approval"
        : "failed";
}

export async function savePersistedStateAndFinishQueue(
  workspace: string,
  jobId: string,
  state: Record<string, unknown>,
  queueId: string,
): Promise<void> {
  const db = await database(workspace);
  db.transaction(() => {
    finishQueueEntryRow(db, queueId, mapStateToQueueStatus(state));
    upsertJobStateRow(db, jobId, JSON.stringify(state));
  })();
}
export async function savePersistedStateAndResolveApprovalQueue(
  workspace: string,
  jobId: string,
  state: Record<string, unknown>,
  queueStatus: "done" | "failed",
): Promise<void> {
  const db = await database(workspace);
  db.transaction(() => {
    resolveApprovalQueueRow(db, jobId, queueStatus);
    upsertJobStateRow(db, jobId, JSON.stringify(state));
  })();
}
