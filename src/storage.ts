import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import { normalizeAdaptiveOptions } from "./adaptive-manager.js";
import { CbxError } from "./errors.js";
import { processAlive } from "./lock.js";

export function now(): string {
  return new Date().toISOString();
}

export interface TaskTemplate {
  task: string;
  test?: string;
  review?: boolean;
  executor?: string;
  isolated?: boolean;
}

export interface RuntimeConfig {
  testCommand?: string;
  review?: boolean;
  isolated?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  maxTurns?: number;
  keepWorktree?: boolean;
  permissionMode?: string;
  reviewRules?: string;
  approval?: { beforeRun?: boolean; beforeComplete?: boolean };
  maxConcurrent?: number;
  git?: { autoBranch?: boolean; autoCommit?: boolean; commitMessage?: string };
  ci?: { failOnReview?: boolean };
  executor?: string;
  reviewExecutor?: string;
  templates?: Record<string, TaskTemplate>;
  execution?: {
    trustMode?: "trusted" | "untrusted";
    /** ESM runner 插件路径（`cbx.runner/v1`）：接管 executor/test/review 命令的进程执行。
     *  配置后 untrusted 信任模式放行——由插件提供容器级隔离，cbx 自身保持零依赖。 */
    runner?: string;
  };
  plugins?: {
    enforce?: boolean;
    allowPaths?: string[];
    allowSha256?: string[];
  };
  notifications?: {
    webhook?: string;
    timeoutMs?: number;
    maxRetries?: number;
    retryBaseMs?: number;
    filters?: {
      events?: string[];
      jobIds?: string[];
      statuses?: string[];
    };
  };
  telemetry?: {
    enabled?: boolean;
    endpoint?: string;
    serviceName?: string;
    timeoutMs?: number;
    maxRetries?: number;
    retryBaseMs?: number;
  };
  governance?: {
    retentionDays?: number;
    /** 启用后，超过 retentionDays 的已终态任务（state/产物/worktree）会被自动清理。
     *  默认 false——保留策略涉及删除数据，必须显式开启。 */
    pruneJobs?: boolean;
    redactFields?: string[];
    redactPatterns?: string[];
  };
  reviewGate?: { enabled?: boolean };
  adaptive?: {
    enabled?: boolean;
    maxRounds?: number;
    managerExecutor?: string;
  };
  dependencyGuard?: boolean;
  ui?: { token?: string };
  context?: {
    tokenBudget?: { manager?: number; executor?: number; auditor?: number };
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} 必须是对象。`);
  return value as Record<string, unknown>;
}
function known(
  value: Record<string, unknown>,
  name: string,
  keys: string[],
): void {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new Error(`${name} 不支持字段：${key}`);
}
function optionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error(`${name} 必须是布尔值。`);
}
function optionalString(value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== "string" || !value.trim()))
    throw new Error(`${name} 必须是非空字符串。`);
}
function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) ||
      Number(value) < minimum ||
      Number(value) > maximum)
  )
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数。`);
}

/** Strict runtime validation prevents unknown policy fields from silently weakening controls. */
export async function loadRuntimeConfig(
  workspaceInput: string,
): Promise<RuntimeConfig> {
  const workspace = path.resolve(workspaceInput);
  const file = path.join(workspace, ".cbx.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  const config = object(parsed, ".cbx.json");
  known(config, ".cbx.json", [
    "testCommand",
    "review",
    "isolated",
    "timeoutMs",
    "maxRetries",
    "maxTurns",
    "keepWorktree",
    "permissionMode",
    "reviewRules",
    "approval",
    "maxConcurrent",
    "git",
    "ci",
    "executor",
    "reviewExecutor",
    "execution",
    "plugins",
    "notifications",
    "telemetry",
    "governance",
    "reviewGate",
    "adaptive",
    "dependencyGuard",
    "ui",
    "context",
    "templates",
  ]);
  optionalString(config.testCommand, "testCommand");
  optionalBoolean(config.review, "review");
  optionalBoolean(config.isolated, "isolated");
  optionalInteger(config.timeoutMs, "timeoutMs", 100);
  optionalInteger(config.maxRetries, "maxRetries", 0);
  optionalInteger(config.maxTurns, "maxTurns", 1);
  optionalBoolean(config.keepWorktree, "keepWorktree");
  optionalString(config.permissionMode, "permissionMode");
  optionalString(config.reviewRules, "reviewRules");
  optionalInteger(config.maxConcurrent, "maxConcurrent", 1);
  optionalString(config.executor, "executor");
  optionalString(config.reviewExecutor, "reviewExecutor");
  optionalBoolean(config.dependencyGuard, "dependencyGuard");
  if (config.approval !== undefined) {
    const value = object(config.approval, "approval");
    known(value, "approval", ["beforeRun", "beforeComplete"]);
    optionalBoolean(value.beforeRun, "approval.beforeRun");
    optionalBoolean(value.beforeComplete, "approval.beforeComplete");
  }
  if (config.git !== undefined) {
    const value = object(config.git, "git");
    known(value, "git", ["autoBranch", "autoCommit", "commitMessage"]);
    optionalBoolean(value.autoBranch, "git.autoBranch");
    optionalBoolean(value.autoCommit, "git.autoCommit");
    optionalString(value.commitMessage, "git.commitMessage");
  }
  if (config.ci !== undefined) {
    const value = object(config.ci, "ci");
    known(value, "ci", ["failOnReview"]);
    optionalBoolean(value.failOnReview, "ci.failOnReview");
  }
  if (config.execution !== undefined) {
    const value = object(config.execution, "execution");
    known(value, "execution", ["trustMode", "runner"]);
    if (
      value.trustMode !== undefined &&
      value.trustMode !== "trusted" &&
      value.trustMode !== "untrusted"
    )
      throw new Error("execution.trustMode 必须是 trusted 或 untrusted。");
    if (value.runner !== undefined && typeof value.runner !== "string")
      throw new Error("execution.runner 必须是字符串（ESM 插件路径）。");
  }
  if (config.plugins !== undefined) {
    const value = object(config.plugins, "plugins");
    known(value, "plugins", ["enforce", "allowPaths", "allowSha256"]);
    optionalBoolean(value.enforce, "plugins.enforce");
    // 收紧默认策略：显式声明 plugins 即表示使用 executor 插件，默认强制校验。
    if (value.enforce === undefined) value.enforce = true;
    for (const key of ["allowPaths", "allowSha256"] as const)
      if (
        value[key] !== undefined &&
        (!Array.isArray(value[key]) ||
          value[key].some((item) => typeof item !== "string" || !item.trim()))
      )
        throw new Error(`plugins.${key} 必须是非空字符串数组。`);
    const hashes = value.allowSha256 as string[] | undefined;
    if (
      hashes !== undefined &&
      hashes.some((hash) => !/^[a-fA-F0-9]{64}$/.test(hash))
    )
      throw new Error("plugins.allowSha256 必须是 SHA-256 十六进制摘要。");
  }
  for (const [name, fields] of [
    [
      "notifications",
      ["webhook", "timeoutMs", "maxRetries", "retryBaseMs", "filters"],
    ],
    [
      "telemetry",
      [
        "enabled",
        "endpoint",
        "serviceName",
        "timeoutMs",
        "maxRetries",
        "retryBaseMs",
      ],
    ],
  ] as const) {
    const raw = config[name];
    if (raw === undefined) continue;
    const value = object(raw, name);
    known(value, name, fields as unknown as string[]);
    optionalString(value.webhook, "notifications.webhook");
    optionalString(value.endpoint, "telemetry.endpoint");
    optionalBoolean(value.enabled, `${name}.enabled`);
    optionalString(value.serviceName, `${name}.serviceName`);
    if (
      name === "telemetry" &&
      value.enabled === true &&
      value.endpoint === undefined
    )
      throw new Error("telemetry.enabled=true 时必须提供 telemetry.endpoint。");
    optionalInteger(value.timeoutMs, `${name}.timeoutMs`, 50, 120_000);
    optionalInteger(value.maxRetries, `${name}.maxRetries`, 0, 10);
    if (
      value.retryBaseMs !== undefined &&
      (typeof value.retryBaseMs !== "number" || value.retryBaseMs < 0)
    )
      throw new Error(`${name}.retryBaseMs 必须是非负数。`);
    // notifications.filters：webhook 事件订阅过滤（仅 notifications 有）。
    if (name === "notifications" && value.filters !== undefined) {
      const filters = object(value.filters, "notifications.filters");
      known(filters, "notifications.filters", ["events", "jobIds", "statuses"]);
      for (const key of ["events", "jobIds", "statuses"] as const) {
        if (
          filters[key] !== undefined &&
          (!Array.isArray(filters[key]) ||
            filters[key].length < 1 ||
            filters[key].some(
              (item) => typeof item !== "string" || !item.trim(),
            ))
        )
          throw new Error(
            `notifications.filters.${key} 必须是非空字符串数组。`,
          );
      }
    }
  }
  if (config.governance !== undefined) {
    const value = object(config.governance, "governance");
    known(value, "governance", [
      "retentionDays",
      "pruneJobs",
      "redactFields",
      "redactPatterns",
    ]);
    optionalInteger(value.retentionDays, "governance.retentionDays", 1, 3650);
    optionalBoolean(value.pruneJobs, "governance.pruneJobs");
    if (
      value.redactFields !== undefined &&
      (!Array.isArray(value.redactFields) ||
        value.redactFields.length > 100 ||
        value.redactFields.some(
          (field) => typeof field !== "string" || !field.trim(),
        ))
    )
      throw new Error("governance.redactFields 必须是最多 100 个非空字符串。");
    // intentional-simple: redactPatterns 只做语法校验（new RegExp 不抛即过），无 catastrophic backtracking 检测；
    // 配置来自工作区所有者（同信任域），ReDoS 风险低。升级路径：引入 safe-regex 类启发式检测。
    if (value.redactPatterns !== undefined) {
      if (
        !Array.isArray(value.redactPatterns) ||
        value.redactPatterns.length > 100
      )
        throw new Error(
          "governance.redactPatterns 必须是最多 100 个正则字符串。",
        );
      for (const pattern of value.redactPatterns) {
        if (typeof pattern !== "string" || !pattern.trim())
          throw new Error("governance.redactPatterns 必须是非空正则字符串。");
        try {
          new RegExp(pattern);
        } catch {
          throw new Error(`governance.redactPatterns 包含无效正则：${pattern}`);
        }
      }
    }
  }
  if (config.reviewGate !== undefined) {
    const value = object(config.reviewGate, "reviewGate");
    known(value, "reviewGate", ["enabled"]);
    optionalBoolean(value.enabled, "reviewGate.enabled");
  }
  if (config.adaptive !== undefined) normalizeAdaptiveOptions(config.adaptive);
  if (config.ui !== undefined) {
    const value = object(config.ui, "ui");
    known(value, "ui", ["token"]);
    optionalString(value.token, "ui.token");
  }
  if (config.context !== undefined) {
    const value = object(config.context, "context");
    known(value, "context", ["tokenBudget"]);
    if (value.tokenBudget !== undefined) {
      const budget = object(value.tokenBudget, "context.tokenBudget");
      known(budget, "context.tokenBudget", ["manager", "executor", "auditor"]);
      for (const role of ["manager", "executor", "auditor"] as const)
        optionalInteger(budget[role], `context.tokenBudget.${role}`, 100);
    }
  }
  if (config.templates !== undefined) {
    // 任务模板：task 必填非空字符串；可选字段类型校验；未知模板键拒绝（防拼写错误静默失效）。
    const templates = object(config.templates, "templates");
    for (const [name, value] of Object.entries(templates)) {
      const tpl = object(value, `templates.${name}`);
      known(tpl, `templates.${name}`, [
        "task",
        "test",
        "review",
        "executor",
        "isolated",
      ]);
      if (typeof tpl.task !== "string" || !tpl.task.trim())
        throw new Error(`templates.${name}.task 必须是必填的非空字符串。`);
      optionalString(tpl.test, `templates.${name}.test`);
      optionalBoolean(tpl.review, `templates.${name}.review`);
      optionalString(tpl.executor, `templates.${name}.executor`);
      optionalBoolean(tpl.isolated, `templates.${name}.isolated`);
    }
  }
  return config as RuntimeConfig;
}

export type CbxDatabase = Database.Database;
// intentional-simple: Promise 缓存保证同 workspace 并发只创建一次连接；创建失败时 reject，
// 不缓存坏 promise，允许下次调用重试。
const databases = new Map<string, Promise<CbxDatabase>>();
// 只读连接：WAL 模式下可安全并发读，不与写连接争抢 prepare/transaction 锁。
const readonlyDatabases = new Map<string, Promise<CbxDatabase>>();

/** 关闭指定 workspace 的 SQLite 连接并从缓存中移除；连接可能仍在异步创建中，
 *  因此等待创建完成后再关闭。未打开的 workspace 不抛错。 */
export async function closeDatabase(workspaceInput: string): Promise<void> {
  const workspace = path.resolve(workspaceInput);
  const rwPromise = databases.get(workspace);
  if (rwPromise) {
    databases.delete(workspace);
    try {
      const db = await rwPromise;
      db.close();
    } catch {
      /* 创建失败的 promise 已在 database() 中清理；此处忽略残留坏 promise */
    }
  }
  const roPromise = readonlyDatabases.get(workspace);
  if (roPromise) {
    readonlyDatabases.delete(workspace);
    try {
      const db = await roPromise;
      db.close();
    } catch {
      /* 同上 */
    }
  }
}

/** 关闭所有缓存的 SQLite 连接；供进程退出清理使用。 */
export async function closeAllDatabases(): Promise<void> {
  const workspaces = new Set([
    ...databases.keys(),
    ...readonlyDatabases.keys(),
  ]);
  await Promise.all([...workspaces].map((workspace) => closeDatabase(workspace)));
}

let exitFlushInstalled = false;
function installDatabaseExitFlush(): void {
  if (exitFlushInstalled) return;
  exitFlushInstalled = true;
  // beforeExit 在事件循环即将为空时触发，允许异步关闭连接；
  // 显式 process.exit()/致命错误不走此路径，属于可接受的最佳努力清理。
  process.once("beforeExit", () => {
    closeAllDatabases().catch(() => undefined);
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
  let promise = databases.get(workspace);
  if (!promise) {
    promise = (async (): Promise<CbxDatabase> => {
      await mkdir(path.join(workspace, ".cbx"), { recursive: true });
      const db = new Database(databaseFile(workspace));
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      migrate(db);
      await importLegacyData(workspace, db);
      return db;
    })();
    databases.set(workspace, promise);
  }
  try {
    return await promise;
  } catch (error) {
    // 创建失败时不缓存坏 promise，允许后续调用重试。
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
async function databaseReadonly(workspaceInput: string): Promise<CbxDatabase> {
  const workspace = path.resolve(workspaceInput);
  const file = databaseFile(workspace);
  // 文件不存在时由写连接负责初始化；不进只读缓存，避免长期持有写连接
  try {
    await stat(file);
  } catch {
    return database(workspace);
  }
  let promise = readonlyDatabases.get(workspace);
  if (!promise) {
    promise = (async (): Promise<CbxDatabase> => {
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
    readonlyDatabases.set(workspace, promise);
  }
  try {
    return await promise;
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
 * 并持久化 cancelled 状态，再 forget 清掉 entries 残留，**单事务**确保 jobs 行删和
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

/** 原子自增并返回下一个事件 seq。用 SQLite 单事务保证跨进程唯一：INSERT OR IGNORE 初始化后 UPDATE ... RETURNING 取新值。
 *  并发进程在 SQLite 行锁下串行化，不会读到相同 seq。 */
export async function nextEventSeq(workspace: string): Promise<number> {
  const db = await database(workspace);
  return db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)").run(
      "event_seq",
      "0",
    );
    const row = db
      .prepare(
        "UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ? RETURNING CAST(value AS INTEGER) AS seq",
      )
      .get("event_seq") as { seq: number } | undefined;
    if (!row) throw new Error("event_seq 分配失败：metadata 表可能已损坏。");
    return Number(row.seq);
  })();
}
async function pruneDeliveryFailureArtifact(
  workspace: string,
  cutoff: number,
): Promise<number> {
  const file = path.join(workspace, ".cbx", "delivery-failures.ndjson");
  const retained: string[] = [];
  let removed = 0;
  try {
    const readline = await import("node:readline");
    const stream = createReadStream(file, { encoding: "utf8" });
    try {
      const reader = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });
      for await (const line of reader) {
        if (!line) continue;
        try {
          const record = JSON.parse(line) as { at?: string; createdAt?: string };
          const at = Date.parse(record.at ?? record.createdAt ?? "");
          if (Number.isFinite(at) && at < cutoff) {
            removed += 1;
            continue;
          }
        } catch {
          /* preserve malformed records for manual recovery */
        }
        retained.push(line);
      }
    } finally {
      try {
        stream.close();
      } catch {
        /* best effort */
      }
    }
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  if (removed)
    await atomicWriteFile(
      file,
      retained.length ? retained.join("\n") + "\n" : "",
    );
  return removed;
}
export async function prunePersistedData(
  workspace: string,
  retentionDays?: number,
): Promise<number> {
  if (!retentionDays) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const db = await database(workspace);
  const sqlite = db
    .prepare("DELETE FROM delivery_failures WHERE created_at < ?")
    .run(new Date(cutoff).toISOString()).changes;
  return sqlite + (await pruneDeliveryFailureArtifact(workspace, cutoff));
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
      return (
        db
          .prepare(
            "UPDATE service_leases SET expires_at = ? WHERE name = ? AND owner_token = ?",
          )
          .run(Date.now() + ttlMs, name, token).changes === 1
      );
    },
    async release(): Promise<void> {
      db.prepare(
        "DELETE FROM service_leases WHERE name = ? AND owner_token = ?",
      ).run(name, token);
    },
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function replaceFile(source: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (
        !new Set(["EACCES", "EPERM", "EBUSY"]).has(String(code)) ||
        attempt === 4
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Write a complete file in the destination directory, fsync it, then atomically replace the destination. */
export async function atomicWriteFile(
  file: string,
  contents: string,
): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await replaceFile(temporary, file);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export async function saveJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n");
}

/** A fallback is used only when the file does not exist. Corrupt JSON always remains visible to callers. */
export async function loadJson<T>(file: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && isMissing(error)) return fallback;
    throw error;
  }
}

/** 常量时间字符串比较：两侧先各取 SHA-256 再 timingSafeEqual，同时规避长度泄漏与逐字节时序差异。 */
export function constantTimeEqual(actual: string, expected: string): boolean {
  const left = createHash("sha256").update(actual, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}
