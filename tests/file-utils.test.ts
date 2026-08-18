import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
// readdir 用于验证临时文件清理；其他 fs 操作通过 file-utils 模块间接测试
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFile, isMissing, loadJson, saveJson } from "../src/file-utils.js";

test("isMissing: ENOENT 返回 true，其他错误返回 false", () => {
  const enoent = Object.assign(new Error("not found"), { code: "ENOENT" });
  assert.equal(isMissing(enoent), true);
  const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.equal(isMissing(eacces), false);
  assert.equal(isMissing(new Error("plain")), false);
});

test("atomicWriteFile: 正常写入 + 原子替换（内容正确且文件存在）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-atomic-"));
  const file = path.join(dir, "target.json");
  await atomicWriteFile(file, "hello");
  assert.equal(await readFile(file, "utf8"), "hello");
  // 覆盖写
  await atomicWriteFile(file, "world");
  assert.equal(await readFile(file, "utf8"), "world");
});

test("atomicWriteFile: 目标路径是目录时 rename 失败 → 清理临时文件 + rethrow", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-atomic-err-"));
  // 把 target 设为已存在的目录 → rename(file, directory) 在 Windows 报 EACCES/EPERM
  const target = path.join(dir, "target");
  await mkdir(target, { recursive: true });
  let thrown: unknown;
  try {
    await atomicWriteFile(target, "content");
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "应抛错（不能 rename 到目录路径）");
  // 临时文件应被清理（.target.*.tmp 不应残留）
  const entries = await readdir(dir);
  const tempFiles = entries.filter((name) => name.includes(".target."));
  assert.equal(tempFiles.length, 0, "临时文件应被 unlink 清理");
});

test("saveJson: 序列化 JSON 并追加换行", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-savejson-"));
  const file = path.join(dir, "data.json");
  await saveJson(file, { key: "value", n: 42 });
  const content = await readFile(file, "utf8");
  assert.equal(content, '{\n  "key": "value",\n  "n": 42\n}\n');
  // roundtrip
  const parsed = JSON.parse(content);
  assert.deepEqual(parsed, { key: "value", n: 42 });
});

test("loadJson: 文件不存在且有 fallback → 返回 fallback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-loadjson-fb-"));
  const fallback = { default: true };
  const result = await loadJson(path.join(dir, "missing.json"), fallback);
  assert.equal(result, fallback);
});

test("loadJson: 文件不存在且无 fallback → 抛 ENOENT", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-loadjson-throw-"));
  await assert.rejects(() => loadJson(path.join(dir, "missing.json")));
});

test("loadJson: 损坏 JSON → 抛 SyntaxError（即使有 fallback 也透传）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-loadjson-bad-"));
  const file = path.join(dir, "bad.json");
  await writeFile(file, "{ broken", "utf8");
  // 有 fallback 时损坏 JSON 仍然抛错（不是 ENOENT，不回退 fallback）
  await assert.rejects(() => loadJson(file, { fallback: true }), SyntaxError);
  // 无 fallback
  await assert.rejects(() => loadJson(file), SyntaxError);
});
