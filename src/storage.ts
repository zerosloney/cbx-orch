import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function now(): string { return new Date().toISOString(); }

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
  try { process.kill(pid, 0); return true; } catch { return false; }
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
