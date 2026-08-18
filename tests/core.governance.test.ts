// governance 子系统测试：脱敏（redactText / redactSensitive）、.cbx.json governance 块校验、
// 保留期清理（prunePersistedData）。此前本文件误放 dispatch reclaim 测试，那些已归并到
// reliability.test.ts 的 reclaim 簇；此处聚焦 governance 存储逻辑的唯一覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  redactText,
  redactSensitive,
} from "../src/redaction.js";
import {
  loadRuntimeConfig,
  prunePersistedData,
} from "../src/storage.js";

// ---- redactText: 行级字段名脱敏 + 全文 pattern 兜底 ----

test("redactText masks values of listed field names (key: v form)", () => {
  const out = redactText("token: abc123\nname: foo", ["token"], []);
  assert.equal(out, "token: [REDACTED]\nname: foo");
});

test("redactText recognizes `- key: v` list-item form", () => {
  const out = redactText("- password: secret", ["password"], []);
  assert.equal(out, "- password: [REDACTED]");
});

test("redactText normalizes `key = v` form to `key: [REDACTED]", () => {
  const out = redactText("api_key = k_123", ["api_key"], []);
  assert.equal(out, "api_key: [REDACTED]");
});

test("redactText leaves lines without a key:value structure intact", () => {
  assert.equal(
    redactText("hello world\nno key here", ["token"], []),
    "hello world\nno key here",
  );
});

test("redactText applies full-text regex patterns globally", () => {
  const out = redactText(
    "use sk-live-1234 and sk_test_5678",
    [],
    ["sk[\\w-]+"],
  );
  assert.equal(out, "use [REDACTED] and [REDACTED]");
});

test("redactText combines field-name and pattern redaction", () => {
  const out = redactText("token: abc\nsee sk-1234", ["token"], ["sk-\\w+"]);
  assert.equal(out, "token: [REDACTED]\nsee [REDACTED]");
});

// ---- redactSensitive: JSON 对象递归脱敏（大小写不敏感）----

test("redactSensitive recurses nested objects case-insensitively", () => {
  const out = redactSensitive(
    { Token: "x", nested: { password: "y", safe: "z" } },
    ["token", "password"],
  );
  assert.deepEqual(out, {
    Token: "[REDACTED]",
    nested: { password: "[REDACTED]", safe: "z" },
  });
});

test("redactSensitive redacts array elements", () => {
  const out = redactSensitive([{ secret: "a" }, { ok: "b" }], ["secret"]);
  assert.deepEqual(out, [{ secret: "[REDACTED]" }, { ok: "b" }]);
});

test("redactSensitive passes through primitives untouched", () => {
  assert.equal(redactSensitive("plain", ["x"]), "plain");
  assert.equal(redactSensitive(42, ["x"]), 42);
  assert.equal(redactSensitive(null, ["x"]), null);
});

// ---- loadRuntimeConfig: governance 块严格校验（未知字段/非法正则/越界值均拒绝）----

async function workspaceWith(config: unknown): Promise<string> {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-gov-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify(config), "utf8");
  return ws;
}

test("loadRuntimeConfig accepts a valid governance block", async () => {
  const ws = await workspaceWith({
    governance: {
      retentionDays: 7,
      redactFields: ["token"],
      redactPatterns: ["sk-\\w+"],
    },
  });
  const cfg = await loadRuntimeConfig(ws);
  assert.equal(cfg.governance?.retentionDays, 7);
  assert.deepEqual(cfg.governance?.redactFields, ["token"]);
  assert.deepEqual(cfg.governance?.redactPatterns, ["sk-\\w+"]);
});

test("loadRuntimeConfig rejects invalid regex in redactPatterns", async () => {
  const ws = await workspaceWith({ governance: { redactPatterns: ["("] } });
  await assert.rejects(() => loadRuntimeConfig(ws));
});

test("loadRuntimeConfig rejects out-of-range retentionDays", async () => {
  const ws = await workspaceWith({ governance: { retentionDays: 99999 } });
  await assert.rejects(() => loadRuntimeConfig(ws));
});

test("loadRuntimeConfig rejects non-array redactFields", async () => {
  const ws = await workspaceWith({ governance: { redactFields: "token" } });
  await assert.rejects(() => loadRuntimeConfig(ws));
});

test("loadRuntimeConfig rejects unknown governance keys", async () => {
  const ws = await workspaceWith({ governance: { bogus: true } });
  await assert.rejects(() => loadRuntimeConfig(ws));
});

// ---- prunePersistedData: 保留期清理 ----

test("prunePersistedData is a no-op when retentionDays is unset", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-gov-prune-"));
  assert.equal(await prunePersistedData(ws), 0);
});
