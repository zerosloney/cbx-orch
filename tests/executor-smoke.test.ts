import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("executor smoke passes a configured fake executable and rejects a missing override", async () => {
  const envVar = "CBX_CODEBUDDY";
  const original = process.env[envVar];
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "cbx-executor-smoke-test-"),
  );
  const fake = path.join(tempDir, "fake-codebuddy.mjs");
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const script = path.join(repoRoot, "scripts", "executor-smoke.mjs");

  const runSmoke = (override: string) =>
    spawnSync(process.execPath, [script, "--executor", "codebuddy"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, [envVar]: override },
    });

  try {
    await writeFile(fake, "process.exit(0);\n", "utf8");
    const passed = runSmoke(fake);
    assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
    assert.match(passed.stdout, /PASS codebuddy/);

    const missing = runSmoke(path.join(tempDir, "missing-codebuddy.mjs"));
    assert.equal(missing.status, 1, `${missing.stdout}\n${missing.stderr}`);
    assert.match(missing.stderr, /FAIL codebuddy/);
    assert.match(missing.stderr, new RegExp(envVar));
  } finally {
    if (original === undefined) delete process.env[envVar];
    else process.env[envVar] = original;
    await rm(tempDir, { recursive: true, force: true });
  }
});
