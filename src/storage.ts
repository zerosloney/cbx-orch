import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";

export function now(): string { return new Date().toISOString(); }

export interface RuntimeConfig {
  testCommand?: string; review?: boolean; isolated?: boolean; timeoutMs?: number; maxRetries?: number; maxTurns?: number;
  keepWorktree?: boolean; permissionMode?: string; reviewRules?: string; approval?: { beforeRun?: boolean }; maxConcurrent?: number;
  git?: { autoBranch?: boolean; autoCommit?: boolean; commitMessage?: string }; ci?: { failOnReview?: boolean }; executor?: string; reviewExecutor?: string;
  execution?: { trustMode?: "trusted" | "untrusted" };
  plugins?: { enforce?: boolean; allowPaths?: string[]; allowSha256?: string[] };
  notifications?: { webhook?: string; timeoutMs?: number; maxRetries?: number; retryBaseMs?: number };
  telemetry?: { enabled?: boolean; endpoint?: string; serviceName?: string; timeoutMs?: number; maxRetries?: number; retryBaseMs?: number };
  governance?: { retentionDays?: number; redactFields?: string[]; redactPatterns?: string[] };
  reviewGate?: { enabled?: boolean };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} 必须是对象。`);
  return value as Record<string, unknown>;
}
function known(value: Record<string, unknown>, name: string, keys: string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${name} 不支持字段：${key}`);
}
function optionalBoolean(value: unknown, name: string): void { if (value !== undefined && typeof value !== "boolean") throw new Error(`${name} 必须是布尔值。`); }
function optionalString(value: unknown, name: string): void { if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error(`${name} 必须是非空字符串。`); }
function optionalInteger(value: unknown, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void { if (value !== undefined && (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum)) throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数。`); }

/** Strict runtime validation prevents unknown policy fields from silently weakening controls. */
export async function loadRuntimeConfig(workspaceInput: string): Promise<RuntimeConfig> {
  const workspace = path.resolve(workspaceInput);
  const file = path.join(workspace, ".cbx.json");
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (isMissing(error)) return {}; throw error; }
  const config = object(parsed, ".cbx.json");
  known(config, ".cbx.json", ["testCommand", "review", "isolated", "timeoutMs", "maxRetries", "maxTurns", "keepWorktree", "permissionMode", "reviewRules", "approval", "maxConcurrent", "git", "ci", "executor", "reviewExecutor", "execution", "plugins", "notifications", "telemetry", "governance", "reviewGate"]);
  optionalString(config.testCommand, "testCommand"); optionalBoolean(config.review, "review"); optionalBoolean(config.isolated, "isolated"); optionalInteger(config.timeoutMs, "timeoutMs", 100); optionalInteger(config.maxRetries, "maxRetries", 0); optionalInteger(config.maxTurns, "maxTurns", 1); optionalBoolean(config.keepWorktree, "keepWorktree"); optionalString(config.permissionMode, "permissionMode"); optionalString(config.reviewRules, "reviewRules"); optionalInteger(config.maxConcurrent, "maxConcurrent", 1); optionalString(config.executor, "executor"); optionalString(config.reviewExecutor, "reviewExecutor");
  if (config.approval !== undefined) { const value = object(config.approval, "approval"); known(value, "approval", ["beforeRun"]); optionalBoolean(value.beforeRun, "approval.beforeRun"); }
  if (config.git !== undefined) { const value = object(config.git, "git"); known(value, "git", ["autoBranch", "autoCommit", "commitMessage"]); optionalBoolean(value.autoBranch, "git.autoBranch"); optionalBoolean(value.autoCommit, "git.autoCommit"); optionalString(value.commitMessage, "git.commitMessage"); }
  if (config.ci !== undefined) { const value = object(config.ci, "ci"); known(value, "ci", ["failOnReview"]); optionalBoolean(value.failOnReview, "ci.failOnReview"); }
  if (config.execution !== undefined) { const value = object(config.execution, "execution"); known(value, "execution", ["trustMode"]); if (value.trustMode !== undefined && value.trustMode !== "trusted" && value.trustMode !== "untrusted") throw new Error("execution.trustMode 必须是 trusted 或 untrusted。"); }
  if (config.plugins !== undefined) { const value = object(config.plugins, "plugins"); known(value, "plugins", ["enforce", "allowPaths", "allowSha256"]); optionalBoolean(value.enforce, "plugins.enforce"); for (const key of ["allowPaths", "allowSha256"] as const) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== "string" || !item.trim()))) throw new Error(`plugins.${key} 必须是非空字符串数组。`); const hashes = value.allowSha256 as string[] | undefined; if (hashes !== undefined && hashes.some(hash => !/^[a-fA-F0-9]{64}$/.test(hash))) throw new Error("plugins.allowSha256 必须是 SHA-256 十六进制摘要。"); }
  for (const [name, fields] of [["notifications", ["webhook", "timeoutMs", "maxRetries", "retryBaseMs"]], ["telemetry", ["enabled", "endpoint", "serviceName", "timeoutMs", "maxRetries", "retryBaseMs"]]] as const) {
    const raw = config[name]; if (raw === undefined) continue;
    const value = object(raw, name); known(value, name, fields as unknown as string[]); optionalString(value.webhook, "notifications.webhook"); optionalString(value.endpoint, "telemetry.endpoint"); optionalBoolean(value.enabled, `${name}.enabled`); optionalString(value.serviceName, `${name}.serviceName`); if (name === "telemetry" && value.enabled === true && value.endpoint === undefined) throw new Error("telemetry.enabled=true 时必须提供 telemetry.endpoint。"); optionalInteger(value.timeoutMs, `${name}.timeoutMs`, 50, 120_000); optionalInteger(value.maxRetries, `${name}.maxRetries`, 0, 10); if (value.retryBaseMs !== undefined && (typeof value.retryBaseMs !== "number" || value.retryBaseMs < 0)) throw new Error(`${name}.retryBaseMs 必须是非负数。`);
  }
  if (config.governance !== undefined) { const value = object(config.governance, "governance"); known(value, "governance", ["retentionDays", "redactFields", "redactPatterns"]); optionalInteger(value.retentionDays, "governance.retentionDays", 1, 3650); if (value.redactFields !== undefined && (!Array.isArray(value.redactFields) || value.redactFields.length > 100 || value.redactFields.some(field => typeof field !== "string" || !field.trim()))) throw new Error("governance.redactFields 必须是最多 100 个非空字符串。"); if (value.redactPatterns !== undefined) { if (!Array.isArray(value.redactPatterns) || value.redactPatterns.length > 100) throw new Error("governance.redactPatterns 必须是最多 100 个正则字符串。"); for (const pattern of value.redactPatterns) { if (typeof pattern !== "string" || !pattern.trim()) throw new Error("governance.redactPatterns 必须是非空正则字符串。"); try { new RegExp(pattern); } catch { throw new Error(`governance.redactPatterns 包含无效正则：${pattern}`); } } } }
  if (config.reviewGate !== undefined) { const value = object(config.reviewGate, "reviewGate"); known(value, "reviewGate", ["enabled"]); optionalBoolean(value.enabled, "reviewGate.enabled"); }
  return config as RuntimeConfig;
}

export function redactSensitive(value: unknown, fields: readonly string[] = []): unknown {
  const sensitive = new Set(fields.map(field => field.toLowerCase()));
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => [key, sensitive.has(key.toLowerCase()) ? "[REDACTED]" : visit(child)]));
  };
  return visit(value);
}

// intentional-simple: 行级键名匹配用单一正则覆盖 `key: v` / `- key: v` / `key = v` 三种形态。
// 抓不到句中内嵌密钥（如 "use sk-xxx here"）；由 redactPatterns 全文正则兜底。
const KEY_LINE = /^\s*([-*]\s+)?([\p{L}\p{N}_][\p{L}\p{N}_\s-]*?)\s*[:=]\s*(.+)$/u;

export function redactText(text: string, fields: readonly string[] = [], patterns: readonly string[] = []): string {
  const sensitive = new Set(fields.map(field => field.toLowerCase()));
  let out = text;
  if (sensitive.size > 0) {
    out = text.split("\n").map(line => {
      const match = line.match(KEY_LINE);
      if (!match) return line;
      const key = match[2].trim().toLowerCase();
      return sensitive.has(key) ? `${match[1] ?? ""}${match[2].trim()}: [REDACTED]` : line;
    }).join("\n");
  }
  for (const pattern of patterns) out = out.replace(new RegExp(pattern, "g"), "[REDACTED]");
  return out;
}

type CbxDatabase = Database.Database;
const databases = new Map<string, CbxDatabase>();
const SCHEMA_VERSION = 3;
function databaseFile(workspace: string): string { return path.join(workspace, ".cbx", "state.sqlite"); }
function migrate(db: CbxDatabase): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const version = Number((db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version);
  if (version < 1) db.transaction(() => {
    db.exec("CREATE TABLE jobs (job_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE queue_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE delivery_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, record_json TEXT NOT NULL); CREATE TABLE service_leases (name TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, now());
  })();
  if (version < 2) db.transaction(() => { db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(2, now()); })();
  if (version < 3) db.transaction(() => {
    db.exec("ALTER TABLE service_leases ADD COLUMN owner_token TEXT");
    db.exec("CREATE TABLE delivery_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, channel TEXT NOT NULL, endpoint TEXT NOT NULL, body_json TEXT NOT NULL, config_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, locked_by TEXT, locked_until INTEGER, last_error TEXT); CREATE INDEX delivery_outbox_available_idx ON delivery_outbox(available_at, id)");
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(3, now());
  })();
  if (version > SCHEMA_VERSION) throw new Error("state.sqlite 的 schema 版本高于当前 cbx，拒绝降级运行。");
}
async function database(workspaceInput: string): Promise<CbxDatabase> {
  const workspace = path.resolve(workspaceInput);
  const cached = databases.get(workspace); if (cached) return cached;
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  const db = new Database(databaseFile(workspace));
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000"); migrate(db);
  const existing = databases.get(workspace); if (existing) { db.close(); return existing; }
  databases.set(workspace, db);
  await importLegacyData(workspace, db);
  return db;
}
async function importLegacyData(workspace: string, db: CbxDatabase): Promise<void> {
  if (db.prepare("SELECT value FROM metadata WHERE key = ?").get("legacy_import_v1")) return;
  const root = path.join(workspace, ".cbx", "jobs");
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (isMissing(error)) entries = []; else throw error; }
  const insert = db.prepare("INSERT OR IGNORE INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?)");
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const state = JSON.parse(await readFile(path.join(root, entry.name, "state.json"), "utf8")) as Record<string, unknown>;
      if (typeof state.jobId === "string") insert.run(state.jobId, JSON.stringify(state), String(state.updatedAt ?? now()));
    } catch (error) { if (!isMissing(error)) console.error(`cbx: 跳过无法导入的旧任务 ${entry.name}：${error instanceof Error ? error.message : error}`); }
  }
  try {
    const lines = (await readFile(path.join(workspace, ".cbx", "delivery-failures.ndjson"), "utf8")).split(/\r?\n/).filter(Boolean);
    const insertFailure = db.prepare("INSERT INTO delivery_failures(created_at, record_json) VALUES (?, ?)");
    db.transaction(() => { for (const line of lines) { const record = JSON.parse(line) as { at?: string }; insertFailure.run(record.at ?? now(), JSON.stringify(record)); } })();
  } catch (error) { if (!isMissing(error)) throw error; }
  db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run("legacy_import_v1", now());
}
async function legacyQueue(workspace: string, db: CbxDatabase, fallback: unknown): Promise<unknown> {
  const existing = db.prepare("SELECT state_json FROM queue_state WHERE singleton = 1").get() as { state_json: string } | undefined;
  if (existing) return JSON.parse(existing.state_json);
  const file = path.join(workspace, ".cbx", "queue.json");
  let value = fallback;
  try { value = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (!isMissing(error)) throw error; }
  db.prepare("INSERT INTO queue_state(singleton, state_json, updated_at) VALUES (1, ?, ?)").run(JSON.stringify(value), now());
  return value;
}

export async function loadPersistedState<T>(workspace: string, jobId: string): Promise<T | undefined> { const db = await database(workspace); const row = db.prepare("SELECT state_json FROM jobs WHERE job_id = ?").get(jobId) as { state_json: string } | undefined; return row ? JSON.parse(row.state_json) as T : undefined; }
export async function savePersistedState(workspace: string, jobId: string, value: unknown): Promise<void> { const db = await database(workspace); db.prepare("INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at").run(jobId, JSON.stringify(value), now()); }
export async function listPersistedStates<T>(workspace: string): Promise<T[]> { const db = await database(workspace); return (db.prepare("SELECT state_json FROM jobs ORDER BY updated_at DESC").all() as Array<{ state_json: string }>).map(row => JSON.parse(row.state_json) as T); }
export async function loadPersistedQueue<T>(workspace: string, fallback: T): Promise<T> { return await legacyQueue(path.resolve(workspace), await database(workspace), fallback) as T; }
export async function savePersistedQueue(workspace: string, value: unknown): Promise<void> { const db = await database(workspace); db.prepare("INSERT INTO queue_state(singleton, state_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at").run(JSON.stringify(value), now()); }
export async function savePersistedStateAndQueue(workspace: string, jobId: string, state: unknown, queue: unknown): Promise<void> {
  const db = await database(workspace); await legacyQueue(path.resolve(workspace), db, { entries: [] });
  db.transaction(() => {
    db.prepare("INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at").run(jobId, JSON.stringify(state), now());
    db.prepare("UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1").run(JSON.stringify(queue), now());
  })();
}
export async function savePersistedStateAndFinishQueue(workspace: string, jobId: string, state: Record<string, unknown>, queueId: string): Promise<void> {
  const db = await database(workspace); await legacyQueue(path.resolve(workspace), db, { entries: [] });
  db.transaction(() => {
    const row = db.prepare("SELECT state_json FROM queue_state WHERE singleton = 1").get() as { state_json: string };
    const queue = JSON.parse(row.state_json) as { entries?: Array<Record<string, unknown>> };
    const entry = queue.entries?.find(item => item.queueId === queueId);
    if (entry) { const status = String(state.status); entry.status = status === "done" ? "done" : status === "cancelled" ? "cancelled" : status === "awaiting_approval" ? "awaiting_approval" : "failed"; entry.finishedAt = now(); entry.pid = undefined; }
    db.prepare("INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at").run(jobId, JSON.stringify(state), now());
    db.prepare("UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1").run(JSON.stringify(queue), now());
  })();
}
export async function recordDeliveryFailure(workspace: string, value: unknown): Promise<void> { const db = await database(workspace); db.prepare("INSERT INTO delivery_failures(created_at, record_json) VALUES (?, ?)").run(now(), JSON.stringify(value)); }

export interface PendingDelivery {
  id: number;
  channel: "webhook" | "otlp";
  endpoint: string;
  body: unknown;
  config: { timeoutMs?: number; maxRetries?: number; retryBaseMs?: number };
  attempts: number;
}

export async function enqueueDelivery(workspace: string, delivery: Omit<PendingDelivery, "id" | "attempts">): Promise<number> {
  const db = await database(workspace);
  const result = db.prepare("INSERT INTO delivery_outbox(created_at, channel, endpoint, body_json, config_json, attempts, available_at) VALUES (?, ?, ?, ?, ?, 0, ?)").run(now(), delivery.channel, delivery.endpoint, JSON.stringify(delivery.body), JSON.stringify(delivery.config), Date.now());
  return Number(result.lastInsertRowid);
}

export async function claimPendingDelivery(workspace: string, owner: string, lockMs = 30_000): Promise<PendingDelivery | undefined> {
  const db = await database(workspace);
  return db.transaction(() => {
    const current = Date.now();
    const row = db.prepare("SELECT id, channel, endpoint, body_json, config_json, attempts FROM delivery_outbox WHERE available_at <= ? AND (locked_until IS NULL OR locked_until < ?) ORDER BY id LIMIT 1").get(current, current) as { id: number; channel: "webhook" | "otlp"; endpoint: string; body_json: string; config_json: string; attempts: number } | undefined;
    if (!row) return undefined;
    const claimed = db.prepare("UPDATE delivery_outbox SET locked_by = ?, locked_until = ? WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)").run(owner, current + lockMs, row.id, current).changes;
    if (!claimed) return undefined;
    return { id: row.id, channel: row.channel, endpoint: row.endpoint, body: JSON.parse(row.body_json), config: JSON.parse(row.config_json), attempts: row.attempts };
  })();
}

export async function rescheduleDelivery(workspace: string, id: number, owner: string, attempts: number, availableAt: number, error: string): Promise<void> {
  const db = await database(workspace);
  db.prepare("UPDATE delivery_outbox SET attempts = ?, available_at = ?, last_error = ?, locked_by = NULL, locked_until = NULL WHERE id = ? AND locked_by = ?").run(attempts, availableAt, error, id, owner);
}

export async function completeDelivery(workspace: string, id: number, owner: string): Promise<void> {
  const db = await database(workspace);
  db.prepare("DELETE FROM delivery_outbox WHERE id = ? AND locked_by = ?").run(id, owner);
}

export async function nextPendingDeliveryAt(workspace: string): Promise<number | undefined> {
  const db = await database(workspace);
  const row = db.prepare("SELECT MIN(CASE WHEN locked_until IS NOT NULL AND locked_until > ? THEN locked_until ELSE available_at END) AS available_at FROM delivery_outbox").get(Date.now()) as { available_at: number | null };
  return row.available_at ?? undefined;
}
async function pruneDeliveryFailureArtifact(workspace: string, cutoff: number): Promise<number> {
  const file = path.join(workspace, ".cbx", "delivery-failures.ndjson");
  let lines: string[];
  try { lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean); } catch (error) { if (isMissing(error)) return 0; throw error; }
  let removed = 0;
  const retained = lines.filter(line => { try { const record = JSON.parse(line) as { at?: string; createdAt?: string }; const at = Date.parse(record.at ?? record.createdAt ?? ""); if (Number.isFinite(at) && at < cutoff) { removed += 1; return false; } } catch { /* preserve malformed records for manual recovery */ } return true; });
  if (removed) await atomicWriteFile(file, retained.length ? retained.join("\n") + "\n" : "");
  return removed;
}
export async function prunePersistedData(workspace: string, retentionDays?: number): Promise<number> { if (!retentionDays) return 0; const cutoff = Date.now() - retentionDays * 86_400_000; const db = await database(workspace); const sqlite = db.prepare("DELETE FROM delivery_failures WHERE created_at < ?").run(new Date(cutoff).toISOString()).changes; return sqlite + await pruneDeliveryFailureArtifact(workspace, cutoff); }
export async function persistedMetrics(workspace: string): Promise<{ jobsByStatus: Record<string, number>; queueDepth: number; failedJobs: number; retryingJobs: number; deliveryFailures: number; pendingDeliveries: number }> { const db = await database(workspace); const rows = db.prepare("SELECT state_json FROM jobs").all() as Array<{ state_json: string }>; const jobsByStatus: Record<string, number> = {}; let retryingJobs = 0; for (const row of rows) { const state = JSON.parse(row.state_json) as { status?: string; phase?: string }; const status = state.status ?? "unknown"; jobsByStatus[status] = (jobsByStatus[status] ?? 0) + 1; if (state.phase === "retrying") retryingJobs += 1; } const queue = await legacyQueue(path.resolve(workspace), db, { entries: [] }) as { entries?: Array<{ status?: string }> }; return { jobsByStatus, queueDepth: (queue.entries ?? []).filter(entry => ["queued", "running", "awaiting_approval"].includes(String(entry.status))).length, failedJobs: jobsByStatus.failed ?? 0, retryingJobs, deliveryFailures: Number((db.prepare("SELECT COUNT(*) AS count FROM delivery_failures").get() as { count: number }).count), pendingDeliveries: Number((db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get() as { count: number }).count) }; }

export interface ServiceLease {
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export async function acquireServiceLease(workspace: string, name: string, ttlMs = 45_000): Promise<ServiceLease> {
  const db = await database(workspace);
  const token = randomBytes(16).toString("hex");
  const acquire = db.transaction(() => {
    const current = Date.now();
    const lease = db.prepare("SELECT owner_pid, expires_at FROM service_leases WHERE name = ?").get(name) as { owner_pid: number; expires_at: number } | undefined;
    if (lease && lease.expires_at > current && processAlive(lease.owner_pid)) throw new Error("已有活跃 serve 实例；每个工作区只允许一个常驻调度器。");
    db.prepare("INSERT INTO service_leases(name, owner_pid, expires_at, owner_token) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner_pid = excluded.owner_pid, expires_at = excluded.expires_at, owner_token = excluded.owner_token").run(name, process.pid, current + ttlMs, token);
  });
  acquire();
  return {
    async renew(): Promise<boolean> { return db.prepare("UPDATE service_leases SET expires_at = ? WHERE name = ? AND owner_token = ?").run(Date.now() + ttlMs, name, token).changes === 1; },
    async release(): Promise<void> { db.prepare("DELETE FROM service_leases WHERE name = ? AND owner_token = ?").run(name, token); },
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function replaceFile(source: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await rename(source, target); return; }
    catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!new Set(["EACCES", "EPERM", "EBUSY"]).has(String(code)) || attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Write a complete file in the destination directory, fsync it, then atomically replace the destination. */
export async function atomicWriteFile(file: string, contents: string): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try { await replaceFile(temporary, file); }
  catch (error) { try { await unlink(temporary); } catch { /* best effort */ } throw error; }
}

export async function saveJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n");
}

/** A fallback is used only when the file does not exist. Corrupt JSON always remains visible to callers. */
export async function loadJson<T>(file: string, fallback?: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) {
    if (fallback !== undefined && isMissing(error)) return fallback;
    throw error;
  }
}

export function processAlive(pid?: number): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException)?.code === "EPERM"; }
}

interface LockRecord { pid?: number; acquiredAt?: string; token?: string; }

async function staleLock(file: string, staleAfterMs: number): Promise<boolean> {
  let record: LockRecord = {};
  let modifiedAt = 0;
  try {
    const [body, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    modifiedAt = info.mtimeMs;
    record = JSON.parse(body) as LockRecord;
  } catch (error) {
    if (isMissing(error)) return false;
    try { modifiedAt = (await stat(file)).mtimeMs; } catch { return false; }
  }
  // A live PID always owns the lock, even if a long-running operation exceeds staleAfterMs.
  if (processAlive(record.pid)) return false;
  const acquiredAt = Date.parse(String(record.acquiredAt ?? ""));
  const ageBase = Number.isFinite(acquiredAt) ? acquiredAt : modifiedAt;
  return Boolean(record.pid) || Date.now() - ageBase >= staleAfterMs;
}

async function reclaimLock(file: string): Promise<boolean> {
  const staleName = `${file}.stale.${process.pid}.${randomBytes(5).toString("hex")}`;
  try {
    await rename(file, staleName);
    await unlink(staleName);
    return true;
  } catch (error) {
    if (isMissing(error)) return true;
    return false;
  }
}

export async function withFileLock<T>(file: string, action: () => Promise<T>, options: { retries?: number; retryDelayMs?: number; staleAfterMs?: number; busyMessage?: string } = {}): Promise<T> {
  const retries = options.retries ?? 40;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  await mkdir(path.dirname(file), { recursive: true });
  const token = randomBytes(12).toString("hex");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; !handle; attempt += 1) {
    try {
      handle = await open(file, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: now(), token }), "utf8");
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await staleLock(file, staleAfterMs) && await reclaimLock(file)) continue;
      if (attempt >= retries) throw new Error(options.busyMessage ?? "锁正在被另一个进程持有，请稍后重试。");
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
  try { return await action(); }
  finally {
    await handle.close();
    try {
      const current = JSON.parse(await readFile(file, "utf8")) as LockRecord;
      if (current.token === token) await unlink(file);
    } catch { /* replaced or already released */ }
  }
}
