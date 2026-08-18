import {
  mkdir,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import { CbxError } from "./errors.js";
import { processAlive } from "./lock.js";
import { isMissing } from "./file-utils.js";

// Re-exports for backward compatibility — modules extracted from storage.ts
export { atomicWriteFile, saveJson, loadJson } from "./file-utils.js";
export { loadRuntimeConfig, type RuntimeConfig, type TaskTemplate } from "./config-loader.js";
export {
  loadPersistedState,
  savePersistedState,
  listPersistedStates,
  forgetPersistedJob,
  loadPersistedQueue,
  savePersistedQueue,
  savePersistedStateAndQueue,
  upsertJobStateRow,
  finishQueueEntryRow,
  resolveApprovalQueueRow,
  mapStateToQueueStatus,
  savePersistedStateAndFinishQueue,
  savePersistedStateAndResolveApprovalQueue,
} from "./queue-persistence.js";
export { nextEventSeq, prunePersistedData } from "./governance.js";

export function now(): string {
  return new Date().toISOString();
}

export type CbxDatabase = Database.Database;
// intentional-simple: Promise 缓存保证同 workspace 并发只创建一次连接；创建失败时 reject，
// 不缓存坏 promise，允许下次调用重试。lastAccessed + idleTimer 实现 60s 空闲自动关闭：
// better-sqlite3 同步操作在微任务中完成，idleTimer 宏任务不会中断在途事务。
interface DbCacheEntry {
  promise: Promise<CbxDatabase>;
  lastAccessed: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}
const databases = new Map<string, DbCacheEntry>();
// 只读连接：WAL 模式下可安全并发读，不与写连接争抢 prepare/transaction 锁。
const readonlyDatabases = new Map<string, DbCacheEntry>();
const IDLE_TIMEOUT_MS = 60_000;

function touchEntry(entry: DbCacheEntry): void {
  entry.lastAccessed = Date.now();
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function scheduleIdleClose(
  map: Map<string, DbCacheEntry>,
  workspace: string,
): void {
  const entry = map.get(workspace);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const current = map.get(workspace);
    if (!current || current !== entry) return;
    map.delete(workspace);
    entry.idleTimer = null;
    entry.promise
      .then((db) => {
        try {
          db.close();
        } catch {
          /* best effort */
        }
      })
      .catch(() => {
        /* creation may have failed */
      });
  }, IDLE_TIMEOUT_MS);
  entry.idleTimer.unref();
}

export async function closeDatabase(
  workspaceInput: string,
): Promise<void> {
  const workspace = path.resolve(workspaceInput);
  for (const map of [databases, readonlyDatabases]) {
    const entry = map.get(workspace);
    if (!entry) continue;
    map.delete(workspace);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      const db = await entry.promise;
      db.close();
    } catch {
      /* creation may have failed — nothing to close */
    }
  }
}

export async function closeAllDatabases(): Promise<void> {
  const workspaces = new Set([
    ...databases.keys(),
    ...readonlyDatabases.keys(),
  ]);
  await Promise.all([...workspaces].map((ws) => closeDatabase(ws)));
}

function installDatabaseExitFlush(): void {
  process.once("beforeExit", async () => {
    try {
      await closeAllDatabases();
    } catch {
      /* best-effort cleanup */
    }
  });
}
installDatabaseExitFlush();
const SCHEMA_VERSION = 4;
function databaseFile(workspace: string): string {
  return path.join(workspace, ".cbx", "state.sqlite");
}
function migrate(db: CbxDatabase): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const version = Number(
    (
      db
        .prepare(
          "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
        )
        .get() as { version: number }
    ).version,
  );
  if (version < 1)
    db.transaction(() => {
      db.exec(
        "CREATE TABLE jobs (job_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE queue_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE delivery_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, record_json TEXT NOT NULL); CREATE TABLE service_leases (name TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
      );
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(1, now());
    })();
  if (version < 2)
    db.transaction(() => {
      db.exec(
        "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(2, now());
    })();
  if (version < 3)
    db.transaction(() => {
      db.exec("ALTER TABLE service_leases ADD COLUMN owner_token TEXT");
      db.exec(
        "CREATE TABLE delivery_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, channel TEXT NOT NULL, endpoint TEXT NOT NULL, body_json TEXT NOT NULL, config_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, locked_by TEXT, locked_until INTEGER, last_error TEXT); CREATE INDEX delivery_outbox_available_idx ON delivery_outbox(available_at, id)",
      );
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(3, now());
    })();
  if (version < 4)
    db.transaction(() => {
      db.exec(
        "CREATE TABLE queue_entries (queue_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, workspace TEXT, extra TEXT, status TEXT NOT NULL, priority REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, pid INTEGER, reclaim_count INTEGER, error TEXT, updated_at TEXT NOT NULL); CREATE INDEX queue_entries_job_idx ON queue_entries(job_id); CREATE TABLE queue_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), max_concurrent INTEGER, paused INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)",
      );
      // v3 及之前的 queue_state 整 blob 一次性拆行迁移；blob 原样保留（仅作降级快照，新代码不再读取）。
      const hasQueueState = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queue_state'",
        )
        .get();
      if (hasQueueState) {
        const legacy = db
          .prepare("SELECT state_json FROM queue_state WHERE singleton = 1")
          .get() as { state_json: string } | undefined;
        if (legacy) {
          try {
            writeQueueRows(db, JSON.parse(legacy.state_json), now());
          } catch {
            /* 损坏 blob：保留原状，加载路径走 queue.json / fallback */
          }
        }
      }
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(4, now());
    })();
  if (version > SCHEMA_VERSION)
    throw new Error("state.sqlite 的 schema 版本高于当前 cbx，拒绝降级运行。");
}
export async function database(workspaceInput: string): Promise<CbxDatabase> {
  const workspace = path.resolve(workspaceInput);
  let entry = databases.get(workspace);
  if (!entry) {
    const promise = (async (): Promise<CbxDatabase> => {
      await mkdir(path.join(workspace, ".cbx"), { recursive: true });
      const db = new Database(databaseFile(workspace));
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      migrate(db);
      await importLegacyData(workspace, db);
      return db;
    })();
    entry = { promise, lastAccessed: Date.now(), idleTimer: null };
    databases.set(workspace, entry);
  }
  touchEntry(entry);
  try {
    const db = await entry.promise;
    scheduleIdleClose(databases, workspace);
    return db;
  } catch (error) {
    databases.delete(workspace);
    throw error;
  }
}

/**
 * SQLite BEGIN IMMEDIATE 事务锁：替代文件锁实现队列写互斥。
 * busy_timeout=5000 提供跨进程等待；SQLITE_BUSY 转换为 E_QUEUE_BUSY 保持兼容。
 * callback 内禁止调用自身开启 db.transaction() 的函数（如 savePersistedQueue），
 * 应直接调用 readQueueRows / writeQueueRows 或内联 SQL。
 */
export async function withQueueTxLock<T>(
  workspace: string,
  action: (db: CbxDatabase) => T,
): Promise<T> {
  const db = await database(workspace);
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "SQLITE_BUSY") {
      throw new CbxError("E_QUEUE_BUSY", "队列正在被另一个调度器更新，请稍后重试。");
    }
    throw error;
  }
  try {
    const result = action(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may already be rolled back */ }
    throw error;
  }
}

/** 只读连接：用于纯查询场景。WAL 模式下可与写并发；
 *  文件不存在或 schema 未初始化时回落到读写连接。 */
export async function databaseReadonly(workspaceInput: string): Promise<CbxDatabase> {
  const workspace = path.resolve(workspaceInput);
  const file = databaseFile(workspace);
  // 文件不存在时由写连接负责初始化；不进只读缓存，避免长期持有写连接
  try {
    await stat(file);
  } catch {
    return database(workspace);
  }
  let entry = readonlyDatabases.get(workspace);
  if (!entry) {
    const promise = (async (): Promise<CbxDatabase> => {
      const db = new Database(file, { readonly: true });
      db.pragma("busy_timeout = 5000");
      // schema 尚未初始化时（如测试场景或首次访问）回落到读写连接；
      // 清除只读缓存，下次访问可重新尝试只读连接
      const hasSchema = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'",
        )
        .get() as { name: string } | undefined;
      if (!hasSchema) {
        db.close();
        readonlyDatabases.delete(workspace);
        return database(workspace);
      }
      return db;
    })();
    entry = { promise, lastAccessed: Date.now(), idleTimer: null };
    readonlyDatabases.set(workspace, entry);
  }
  touchEntry(entry);
  try {
    const db = await entry.promise;
    scheduleIdleClose(readonlyDatabases, workspace);
    return db;
  } catch (error) {
    readonlyDatabases.delete(workspace);
    throw error;
  }
}

async function importLegacyData(
  workspace: string,
  db: CbxDatabase,
): Promise<void> {
  if (
    db
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get("legacy_import_v1")
  )
    return;
  // 先异步收集再单事务提交：损坏行跳过并留痕而非致命抛出，避免一条坏记录锁死整个 workspace；
  // 任务、失败记录与幂等标记同事务落盘，崩溃后整体重放，不产生部分导入或重复失败记录。
  const jobRows: Array<{
    jobId: string;
    stateJson: string;
    updatedAt: string;
  }> = [];
  const root = path.join(workspace, ".cbx", "jobs");
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) entries = [];
    else throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const state = JSON.parse(
        await readFile(path.join(root, entry.name, "state.json"), "utf8"),
      ) as Record<string, unknown>;
      if (typeof state.jobId === "string")
        jobRows.push({
          jobId: state.jobId,
          stateJson: JSON.stringify(state),
          updatedAt: String(state.updatedAt ?? now()),
        });
    } catch (error) {
      if (!isMissing(error))
        console.error(
          `cbx: 跳过无法导入的旧任务 ${entry.name}：${error instanceof Error ? error.message : error}`,
        );
    }
  }
  const failureRows: Array<{ createdAt: string; recordJson: string }> = [];
  try {
    const lines = (
      await readFile(
        path.join(workspace, ".cbx", "delivery-failures.ndjson"),
        "utf8",
      )
    )
      .split(/\r?\n/)
      .filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as { at?: string };
        failureRows.push({
          createdAt: record.at ?? now(),
          recordJson: JSON.stringify(record),
        });
      } catch (error) {
        console.error(
          `cbx: 跳过无法解析的旧投递失败记录：${error instanceof Error ? error.message : error}`,
        );
      }
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const insertJob = db.prepare(
    "INSERT OR IGNORE INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?)",
  );
  const insertFailure = db.prepare(
    "INSERT INTO delivery_failures(created_at, record_json) VALUES (?, ?)",
  );
  db.transaction(() => {
    for (const row of jobRows)
      insertJob.run(row.jobId, row.stateJson, row.updatedAt);
    for (const row of failureRows)
      insertFailure.run(row.createdAt, row.recordJson);
    db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run(
      "legacy_import_v1",
      now(),
    );
  })();
}
/** queue 行级持久化的宽松形状：storage 层不依赖 queue.ts 的具体类型（避免循环 import）。 */
export interface PersistedQueueLike {
  entries?: Array<Record<string, unknown>>;
  paused?: boolean;
  maxConcurrent?: number;
  updatedAt?: string;
}

interface QueueEntryRow {
  queue_id: string;
  job_id: string;
  workspace: string | null;
  extra: string | null;
  status: string;
  priority: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  pid: number | null;
  reclaim_count: number | null;
  error: string | null;
}

const UPSERT_QUEUE_ENTRY =
  "INSERT INTO queue_entries(queue_id, job_id, workspace, extra, status, priority, created_at, started_at, finished_at, pid, reclaim_count, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(queue_id) DO UPDATE SET job_id = excluded.job_id, workspace = excluded.workspace, extra = excluded.extra, status = excluded.status, priority = excluded.priority, created_at = excluded.created_at, started_at = excluded.started_at, finished_at = excluded.finished_at, pid = excluded.pid, reclaim_count = excluded.reclaim_count, error = excluded.error, updated_at = excluded.updated_at";

/**
 * queue 行级全量写回：meta UPSERT + 逐行 UPSERT + 删除列表外残留行（截断/forget 生效路径）。
 * 须在调用方事务内执行；跳过缺失 queueId 的损坏行（与 listPersistedStates 跳过策略一致）。
 */
export function writeQueueRows(
  db: CbxDatabase,
  queue: PersistedQueueLike,
  timestamp: string,
): void {
  const entries = (Array.isArray(queue.entries) ? queue.entries : []).filter(
    (entry) => typeof entry.queueId === "string" && entry.queueId,
  );
  db.prepare(
    "INSERT INTO queue_meta(singleton, max_concurrent, paused, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET max_concurrent = excluded.max_concurrent, paused = excluded.paused, updated_at = excluded.updated_at",
  ).run(
    typeof queue.maxConcurrent === "number" ? queue.maxConcurrent : null,
    queue.paused ? 1 : 0,
    typeof queue.updatedAt === "string" ? queue.updatedAt : timestamp,
  );
  const upsert = db.prepare(UPSERT_QUEUE_ENTRY);
  for (const entry of entries) {
    upsert.run(
      entry.queueId as string,
      String(entry.jobId ?? ""),
      typeof entry.workspace === "string" ? entry.workspace : null,
      typeof entry.extra === "string" ? entry.extra : null,
      String(entry.status ?? "queued"),
      Number(entry.priority ?? 0) || 0,
      typeof entry.createdAt === "string" ? entry.createdAt : timestamp,
      typeof entry.startedAt === "string" ? entry.startedAt : null,
      typeof entry.finishedAt === "string" ? entry.finishedAt : null,
      typeof entry.pid === "number" ? entry.pid : null,
      typeof entry.reclaimCount === "number" ? entry.reclaimCount : null,
      typeof entry.error === "string" ? entry.error : null,
      timestamp,
    );
  }
  const ids = entries.map((entry) => entry.queueId as string);
  if (ids.length === 0) db.prepare("DELETE FROM queue_entries").run();
  else {
    const placeholders = ids.map(() => "?").join(", ");
    db.prepare(
      `DELETE FROM queue_entries WHERE queue_id NOT IN (${placeholders})`,
    ).run(...ids);
  }
}

/** 读行级表组装 queue 对象；库中无任何 queue 数据时返回 undefined（调用方走 queue.json/fallback）。 */
export function readQueueRows(db: CbxDatabase): PersistedQueueLike | undefined {
  const meta = db
    .prepare(
      "SELECT max_concurrent, paused, updated_at FROM queue_meta WHERE singleton = 1",
    )
    .get() as
    | { max_concurrent: number | null; paused: number; updated_at: string }
    | undefined;
  const rows = db
    .prepare(
      "SELECT queue_id, job_id, workspace, extra, status, priority, created_at, started_at, finished_at, pid, reclaim_count, error FROM queue_entries ORDER BY created_at ASC, queue_id ASC",
    )
    .all() as QueueEntryRow[];
  if (!meta && rows.length === 0) return undefined;
  return {
    maxConcurrent: meta?.max_concurrent ?? undefined,
    paused: meta?.paused === 1,
    updatedAt: meta?.updated_at,
    entries: rows.map((row) => ({
      queueId: row.queue_id,
      jobId: row.job_id,
      workspace: row.workspace ?? "",
      extra: row.extra ?? "",
      status: row.status,
      priority: row.priority,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      pid: row.pid ?? undefined,
      reclaimCount: row.reclaim_count ?? undefined,
      error: row.error ?? undefined,
    })),
  };
}

/** 读取 metadata 表中 key 对应的字符串值；不存在返回 undefined。 */
export async function getMetadata(
  workspace: string,
  key: string,
): Promise<string | undefined> {
  const db = await databaseReadonly(workspace);
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/** 写入 metadata 表（upsert）。 */
export async function setMetadata(
  workspace: string,
  key: string,
  value: string,
): Promise<void> {
  const db = await database(workspace);
  db.prepare(
    "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export async function persistedMetrics(workspace: string): Promise<{
  jobsByStatus: Record<string, number>;
  queueDepth: number;
  failedJobs: number;
  retryingJobs: number;
  deliveryFailures: number;
  pendingDeliveries: number;
}> {
  const db = await database(workspace);
  const rows = db.prepare("SELECT state_json FROM jobs").all() as Array<{
    state_json: string;
  }>;
  const jobsByStatus: Record<string, number> = {};
  let retryingJobs = 0;
  for (const row of rows) {
    const state = JSON.parse(row.state_json) as {
      status?: string;
      phase?: string;
    };
    const status = state.status ?? "unknown";
    jobsByStatus[status] = (jobsByStatus[status] ?? 0) + 1;
    if (state.phase === "retrying") retryingJobs += 1;
  }
  const queue = readQueueRows(db) ?? { entries: [] };
  return {
    jobsByStatus,
    queueDepth: (queue.entries ?? []).filter((entry) =>
      ["queued", "running", "awaiting_approval"].includes(String(entry.status)),
    ).length,
    failedJobs: jobsByStatus.failed ?? 0,
    retryingJobs,
    deliveryFailures: Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM delivery_failures").get() as {
          count: number;
        }
      ).count,
    ),
    pendingDeliveries: Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get() as {
          count: number;
        }
      ).count,
    ),
  };
}

export interface ServiceLease {
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export async function acquireServiceLease(
  workspace: string,
  name: string,
  ttlMs = 45_000,
): Promise<ServiceLease> {
  const db = await database(workspace);
  const token = randomBytes(16).toString("hex");
  const acquire = db.transaction(() => {
    const current = Date.now();
    const lease = db
      .prepare(
        "SELECT owner_pid, expires_at FROM service_leases WHERE name = ?",
      )
      .get(name) as { owner_pid: number; expires_at: number } | undefined;
    if (lease && lease.expires_at > current && processAlive(lease.owner_pid))
      throw new Error("已有活跃 serve 实例；每个工作区只允许一个常驻调度器。");
    db.prepare(
      "INSERT INTO service_leases(name, owner_pid, expires_at, owner_token) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner_pid = excluded.owner_pid, expires_at = excluded.expires_at, owner_token = excluded.owner_token",
    ).run(name, process.pid, current + ttlMs, token);
  });
  acquire();
  return {
    async renew(): Promise<boolean> {
      // touch: 更新 lastAccessed 并取消 idleTimer，防止 lease 续期期间连接被空闲关闭
      const leaseDb = await database(workspace);
      return (
        leaseDb
          .prepare(
            "UPDATE service_leases SET expires_at = ? WHERE name = ? AND owner_token = ?",
          )
          .run(Date.now() + ttlMs, name, token).changes === 1
      );
    },
    async release(): Promise<void> {
      const leaseDb = await database(workspace);
      leaseDb.prepare(
        "DELETE FROM service_leases WHERE name = ? AND owner_token = ?",
      ).run(name, token);
    },
  };
}

/** 常量时间字符串比较：两侧先各取 SHA-256 再 timingSafeEqual，同时规避长度泄漏与逐字节时序差异。 */
export function constantTimeEqual(actual: string, expected: string): boolean {
  const left = createHash("sha256").update(actual, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}
