import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CbxError, type CbxErrorCode } from "./errors.js";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function processAlive(pid?: number): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

interface LockRecord {
  pid?: number;
  acquiredAt?: string;
  token?: string;
}

/** 判定锁文件是否可回收：存活 pid 永远持有锁；死 pid 或超龄（acquiredAt 缺失时退回 mtime）视为过期。导出供测试覆盖各分支。 */
export async function staleLock(
  file: string,
  staleAfterMs: number,
): Promise<boolean> {
  let record: LockRecord = {};
  let modifiedAt = 0;
  try {
    const [body, info] = await Promise.all([
      readFile(file, "utf8"),
      stat(file),
    ]);
    modifiedAt = info.mtimeMs;
    record = JSON.parse(body) as LockRecord;
  } catch (error) {
    if (isMissing(error)) return false;
    try {
      modifiedAt = (await stat(file)).mtimeMs;
    } catch {
      return false;
    }
  }
  if (processAlive(record.pid)) return false;
  const acquiredAt = Date.parse(String(record.acquiredAt ?? ""));
  const ageBase = Number.isFinite(acquiredAt) ? acquiredAt : modifiedAt;
  return Boolean(record.pid) || Date.now() - ageBase >= staleAfterMs;
}

async function reclaimLock(file: string): Promise<boolean> {
  const staleName = `${file}.stale.${process.pid}.${randomBytes(5).toString("hex")}`;
  try {
    await rename(file, staleName);
  } catch (error) {
    if (isMissing(error)) return true;
    return false;
  }
  try {
    const record = JSON.parse(await readFile(staleName, "utf8")) as LockRecord;
    if (processAlive(record.pid)) {
      try {
        await rename(staleName, file);
      } catch {
        await unlink(staleName).catch(() => undefined);
      }
      return false;
    }
  } catch {
    /* 内容缺失/损坏：按可回收处理 */
  }
  await unlink(staleName).catch(() => undefined);
  return true;
}

// intentional-simple: SIGKILL（不可捕获信号）后锁文件残留，依赖 staleAfterMs（默认 30s）回收——
// 文件锁固有局限；完全消除需改用 flock 或 SQLite 事务（跨进程互斥由内核/DB 保证）。
export async function withFileLock<T>(
  file: string,
  action: () => Promise<T>,
  options: {
    retries?: number;
    retryDelayMs?: number;
    staleAfterMs?: number;
    busyMessage?: string;
    busyCode?: CbxErrorCode;
  } = {},
): Promise<T> {
  const retries = options.retries ?? 40;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  await mkdir(path.dirname(file), { recursive: true });
  const token = randomBytes(12).toString("hex");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; !handle; attempt += 1) {
    try {
      handle = await open(file, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token }),
        "utf8",
      );
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await staleLock(file, staleAfterMs)) && (await reclaimLock(file)))
        continue;
      if (attempt >= retries)
        throw new CbxError(
          options.busyCode ?? "E_LOCK_BUSY",
          options.busyMessage ?? "锁正在被另一个进程持有，请稍后重试。",
        );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  try {
    return await action();
  } finally {
    await handle.close();
    try {
      const current = JSON.parse(await readFile(file, "utf8")) as LockRecord;
      if (current.token === token) await unlink(file);
    } catch {
      /* replaced or already released */
    }
  }
}

/** 队列写互斥的唯一来源：调度器整 blob 写回与 worker 终态双写必须共用同一把锁，否则会互相覆盖。 */
export function queueLockFile(workspace: string): string {
  return path.join(workspace, ".cbx", "queue.lock");
}
export function withQueueLock<T>(
  workspace: string,
  action: () => Promise<T>,
  options: { retries?: number } = {},
): Promise<T> {
  return withFileLock(queueLockFile(workspace), action, {
    retries: options.retries ?? 40,
    busyMessage: "队列正在被另一个调度器更新，请稍后重试。",
    busyCode: "E_QUEUE_BUSY",
  });
}
