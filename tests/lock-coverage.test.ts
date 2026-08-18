import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { staleLock, withFileLock } from "../src/lock.js";

// 补测 lock.ts 未覆盖分支：
// - staleLock: 文件不存在/corrupt JSON/死 PID+旧时间戳/活 PID
// - reclaimLock: 内容损坏时回收 + 活 PID 时回滚（通过 withFileLock 间接触发）

async function touchFile(file: string, content: string, ageMs = 0): Promise<void> {
  await writeFile(file, content, "utf8");
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    const { utimes } = await import("node:fs/promises");
    await utimes(file, past, past);
  }
}

// ---- staleLock ----

test("staleLock: 文件不存在返回 false", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-lock-stale-"));
  assert.equal(await staleLock(path.join(dir, "missing.lock"), 1000), false);
});

test("staleLock: 死 PID + 旧 acquiredAt → 过期返回 true", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-lock-stale-old-"));
  const file = path.join(dir, "test.lock");
  const old = new Date(Date.now() - 5000).toISOString();
  await writeFile(file, JSON.stringify({ pid: 999999, acquiredAt: old }), "utf8");
  // pid 999999 不存在 → processAlive false；acquiredAt 5s 前 > staleAfterMs 1000 → true
  assert.equal(await staleLock(file, 1000), true);
});

test("staleLock: 死 PID + 新 acquiredAt → 仍返回 true（死 PID 恒过期）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-lock-stale-new-"));
  const file = path.join(dir, "test.lock");
  const recent = new Date().toISOString();
  await writeFile(file, JSON.stringify({ pid: 999999, acquiredAt: recent }), "utf8");
  // pid 死 → Boolean(999999)=true → 直接返回 true（时间不参与判定）
  assert.equal(await staleLock(file, 30000), true);
});

test("staleLock: 活 PID（当前进程）→ 返回 false", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-lock-stale-live-"));
  const file = path.join(dir, "test.lock");
  await writeFile(file, JSON.stringify({ pid: process.pid, acquiredAt: new Date(Date.now() - 60000).toISOString() }), "utf8");
  // pid 是当前进程 → processAlive true → false（即使时间很旧）
  assert.equal(await staleLock(file, 100), false);
});

test("staleLock: 损坏 JSON + 旧 mtime → 基于 mtime 判定过期", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-lock-stale-corrupt-"));
  const file = path.join(dir, "test.lock");
  await touchFile(file, "not-json", 5000);
  // JSON.parse 失败 → catch → stat 成功 → record={} → Boolean(undefined)=false → 检查 mtime age
  // mtime 5s 前 > staleAfterMs 1000 → true
  assert.equal(await staleLock(file, 1000), true);
});

test("staleLock: 损坏 JSON + 新 mtime → 未过期", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-lock-stale-corrupt-new-"));
  const file = path.join(dir, "test.lock");
  await writeFile(file, "not-json", "utf8");
  // mtime 新 → false
  assert.equal(await staleLock(file, 30000), false);
});

test("staleLock: 有 PID 但无 acquiredAt → Boolean(pid) 为 true 直接返回", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-lock-stale-pid-only-"));
  const file = path.join(dir, "test.lock");
  // pid 存在但死 + 无 acquiredAt → Boolean(999999)=true → 直接返回 true（不需要时间判定）
  await writeFile(file, JSON.stringify({ pid: 999999 }), "utf8");
  assert.equal(await staleLock(file, 30000), true);
});

// ---- reclaimLock（通过 withFileLock 间接触发）----

test("withFileLock: 损坏锁文件被回收后成功获取锁", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-lock-reclaim-corrupt-"));
  const file = path.join(dir, "test.lock");
  // 创建一个旧且损坏的锁文件 → staleLock 返回 true → reclaimLock:
  // rename 成功 → JSON.parse 失败（catch → "按可回收处理"）→ unlink stale → return true
  // → withFileLock continue → 成功创建新锁
  const past = new Date(Date.now() - 60000);
  const { utimes } = await import("node:fs/promises");
  await writeFile(file, "corrupt-lock-content", "utf8");
  await utimes(file, past, past);
  const result = await withFileLock(file, async () => "reclaimed");
  assert.equal(result, "reclaimed");
});

test("withFileLock: 活 PID 锁文件回收失败后重试并最终超时", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-lock-reclaim-live-"));
  const file = path.join(dir, "test.lock");
  // 创建一个"活 PID"锁文件 → staleLock 返回 false（processAlive true）
  // → reclaimLock 不被调用 → withFileLock 进入重试 → retries=0 → 抛 E_LOCK_BUSY
  await writeFile(
    file,
    JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
    "utf8",
  );
  await assert.rejects(
    () => withFileLock(file, async () => "should-not-reach", { retries: 0 }),
    /锁正在被另一个进程持有/,
  );
});
