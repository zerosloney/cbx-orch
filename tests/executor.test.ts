import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectExecutorPlugin, loadExecutorPlugin } from "../src/executor.js";

const manifest = `export const manifest = { apiVersion: "cbx.executor/v1", name: "approved", version: "1.2.3", capabilities: ["execute"] }; export async function run() { return { code: 0 }; }`;

test("plugin manifest identity is versioned and SHA allowlists enforce both configured controls", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-policy-"));
  const plugin = path.join(workspace, "approved.mjs");
  await writeFile(plugin, manifest, "utf8");
  const identity = await inspectExecutorPlugin(plugin, workspace);
  assert.equal(identity.name, "approved");
  assert.equal(identity.version, "1.2.3");
  assert.equal(identity.sha256.length, 64);
  await assert.rejects(
    () =>
      inspectExecutorPlugin(plugin, workspace, {
        enforce: true,
        allowPaths: [plugin],
        allowSha256: ["0".repeat(64)],
      }),
    /SHA-256 未获批准/,
  );
  await assert.rejects(
    () =>
      inspectExecutorPlugin(plugin, workspace, {
        enforce: true,
        allowSha256: [identity.sha256],
        allowPaths: ["other.mjs"],
      }),
    /路径未获批准/,
  );
  assert.equal(
    (
      await inspectExecutorPlugin(plugin, workspace, {
        enforce: true,
        allowPaths: [plugin],
        allowSha256: [identity.sha256],
      })
    ).sha256,
    identity.sha256,
  );
});

test("legacy plugins remain compatible unless policy enforcement is enabled", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-legacy-"));
  const plugin = path.join(workspace, "legacy.mjs");
  await writeFile(
    plugin,
    "export async function run() { return { code: 0 }; }",
    "utf8",
  );
  assert.equal(
    (await inspectExecutorPlugin(plugin, workspace)).version,
    "legacy",
  );
  await assert.rejects(
    () =>
      inspectExecutorPlugin(plugin, workspace, {
        enforce: true,
        allowPaths: [plugin],
      }),
    /缺少 manifest/,
  );
});

test("expected SHA mismatch rejects before plugin top-level code runs", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-sha-"));
  const plugin = path.join(workspace, "changed.mjs");
  const sideEffect = path.join(workspace, "plugin-ran");
  await writeFile(
    plugin,
    `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(sideEffect)}, "ran"); ${manifest}`,
    "utf8",
  );

  await assert.rejects(
    () => loadExecutorPlugin(plugin, workspace, {}, "0".repeat(64)),
    /内容在启动前发生变化/,
  );
  await assert.rejects(() => access(sideEffect), { code: "ENOENT" });
});
